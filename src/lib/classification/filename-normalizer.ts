import { type Message } from 'coze-coding-dev-sdk';

import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from './chat-completions';
import { SPEC_TERMS } from './naming-spec';
import { leafName } from './source-path';

/**
 * 文件名归一化：把真实文件名对到客户规范里的词条。
 *
 * **模型在这一步只做同义归一，绝不输出业务阶段。** 词条到阶段的映射由 naming-spec
 * 里数出来的表决定，是确定的。这条分工是有意的：如果让模型看着文件名直接判阶段，
 * 面对《君柔信用报告》这种规范根本没覆盖的文件，它一定会给出一个像模像样的答案
 * （多半是"尽职调查"，因为信用报告听起来就像尽调材料）——那正是这套系统一路在防的
 * "看名字瞎猜"。限定它只能从固定清单里选、或者答"无"，幻觉空间小得多。
 *
 * 用模型而不是关键词表来做这一步，是因为形变太多：规范写"立项评审纪要"，实际文件
 * 叫"立项会纪要"；规范写"立项申请书"，实际叫"立项申请"；文件名还普遍带项目名前缀、
 * 序号、方括号、版本号和重名后缀。维护别名表是打不完的地鼠，同义归一恰好是模型最
 * 擅长的事。
 *
 * 整批只调一次：几十个文件名一次发过去，一次拿回来。
 */

export const FILENAME_NORMALIZER_MODEL =
  process.env.FILENAME_NORMALIZER_MODEL?.trim() || 'doubao-seed-2-0-mini-260215';
const FILENAME_NORMALIZER_TIMEOUT_MS = 60_000;
/** 每个文件一行短输出，留足余量即可。 */
const OUTPUT_TOKENS_PER_FILE = 24;
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 4_000;

export interface FilenameNormalizeResult {
  status: 'success' | 'fallback';
  /** 下标与传入的 sourcePaths 一一对应；null 表示没有对应词条。 */
  terms: Array<string | null>;
  modelCall?: ModelCallDiagnostics;
  error?: string;
}

export function buildFilenameNormalizePrompt(sourcePaths: string[]): Message[] {
  const systemPrompt = `你的任务是把文件名对应到给定清单里的词条。这是同义归一，不是分类。

【可选词条】
${SPEC_TERMS.join('、')}

【要求】
1. 只能输出上面清单里的词条原文，或者"无"。不得输出清单以外的任何词。
2. 不要输出业务阶段、归档目录、文件类型或任何解释。
3. 文件名普遍带有项目名、公司名、序号、方括号、版本号、重复后缀（如"(1)"）和扩展名，
   这些都是噪声，判断时忽略。
4. 【只做同义改写，不做归类推理】说法不同但**指同一种文件**的，归到清单里的词条。
   例如"立项会纪要"对应"立项评审纪要"、"法务尽调报告"对应"法律尽职调查报告"——
   这些是同一样东西的不同叫法，文件名里看得到相同的字。
   **不要做"这大概也算一种X"的推理**：文件名说的东西如果和词条只是同属一个大类、
   而不是同一种文件，输出"无"。（实测反例：把"投资合同书"归到"交易协议"——两者
   一个共同字都没有，只是都属于协议类，这种就该答"无"。）
5. 【对不上就答"无"，这一条最重要】文件名说的东西如果不在清单里，必须输出"无"，
   不要挑一个最接近的凑数。清单没覆盖的文件由后续环节读内容来判断，答"无"是正确
   且有用的结果，不是失败。凭文件名硬凑一个词条会把后续判断带偏。
6. 文件名只有公司名、项目名、编号，或者含义不明时，一律输出"无"。

【输出格式】
每个文件一行，格式为 "序号:词条" 或 "序号:无"。不要输出表头、编号以外的文字、
Markdown 或空行。行数必须与输入的文件数完全一致。`;

  const userPrompt = `【文件名】
${sourcePaths
    .map((sourcePath, index) => `${index + 1}. ${leafName(sourcePath)}`)
    .join('\n')}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 解析 "序号:词条" 的逐行输出。
 *
 * 按序号回填而不是按行序——模型偶尔会多打或少打一行，按行序对齐会让**后面所有文件
 * 集体错位**，那种错误比少认几个文件严重得多，而且很难看出来。
 */
export function parseFilenameNormalizeResponse(
  content: string,
  expectedCount: number
): Array<string | null> {
  const terms = new Array<string | null>(expectedCount).fill(null);
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const matched = /^(\d+)\s*[:：]\s*(.+)$/.exec(line);
    if (!matched) continue;
    const index = Number(matched[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) continue;
    const value = matched[2].trim().replace(/^["'《]|["'》]$/g, '');
    if (!value || value === '无') continue;
    // 清单以外的词一律丢弃，交给 matchSpecTerm 当作没匹配上。
    terms[index] = SPEC_TERMS.includes(value) ? value : null;
  }
  return terms;
}

/**
 * 整批归一化。失败时返回全 null——等于所有文件都走完整事实链路，
 * 也就是没有这一步之前的行为，不会把流程卡住。
 */
export async function normalizeFilenamesWithModel(params: {
  sourcePaths: string[];
  customHeaders?: Record<string, string>;
}): Promise<FilenameNormalizeResult> {
  const { sourcePaths } = params;
  if (sourcePaths.length === 0) {
    return { status: 'success', terms: [] };
  }

  let modelCall: ModelCallDiagnostics | undefined;
  try {
    const response = await invokeChatCompletion({
      messages: buildFilenameNormalizePrompt(sourcePaths),
      model: FILENAME_NORMALIZER_MODEL,
      temperature: 0,
      maxOutputTokens: Math.min(
        MAX_OUTPUT_TOKENS,
        Math.max(MIN_OUTPUT_TOKENS, sourcePaths.length * OUTPUT_TOKENS_PER_FILE)
      ),
      customHeaders: params.customHeaders,
      timeoutMs: FILENAME_NORMALIZER_TIMEOUT_MS,
    });
    modelCall = response.diagnostics;
    return {
      status: 'success',
      terms: parseFilenameNormalizeResponse(
        response.content,
        sourcePaths.length
      ),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Filename normalize error:', error);
    return {
      status: 'fallback',
      terms: new Array<string | null>(sourcePaths.length).fill(null),
      modelCall,
      error: `文件名归一化失败：${message}`,
    };
  }
}
