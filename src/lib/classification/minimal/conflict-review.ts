import { type Message } from 'coze-coding-dev-sdk';

import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from '../chat-completions';
import { extractFirstJsonObject } from '../document-facts';
import { leafName } from '../source-path';
import { describeTimeline, type TimelineEntry } from './evidence';
import type { MinimalDocument } from './store';

/**
 * 冲突复核：把全项目的时间线和当前归档结果交给模型，让它指出自相矛盾之处。
 *
 * 这一步取代了原先写在代码里的一致性校验器。那个校验器内置了若干业务规则——
 * 交易前后侧、同类文件版本先后、"有交割确认函通常应有增资协议"——每一条都是
 * 预设：它只能发现被预先想到的那几种矛盾，换一类项目就失效，而且会把"清单上
 * 没写"误报成"没有问题"。
 *
 * 现在代码只负责把事实摆出来，什么算矛盾由模型判断。代价是这一步不再是确定性的，
 * 所以结论一律作为**提示**呈现给用户，不自动改动任何归档结果。
 */

/**
 * 冲突复核用的模型，可用 CONFLICT_REVIEW_MODEL 环境变量覆盖。
 *
 * 这一步比分类难得多：要同时持有全项目所有文件的状态做交叉推理。实测
 * doubao-seed-2-0-mini 在这里连报四条误报且自相矛盾（同一条依据同时否定两个
 * 方向相反的归档），所以默认换成同代的非 mini 版本。
 *
 * 模型 ID 不能靠猜：实测 doubao-seed-2-0-260215（同代非 mini）在本环境返回
 * ErrNotFound，而 pro 版本可用。换之前先跑 `node scripts/probe-model.mjs`。
 *
 * 这一步每次归档只调一次，pro 比 mini 慢约 3 秒，影响可以接受。
 */
export const CONFLICT_REVIEW_MODEL =
  process.env.CONFLICT_REVIEW_MODEL?.trim() || 'doubao-seed-2-0-pro-260215';
const CONFLICT_REVIEW_MAX_OUTPUT_TOKENS = 800;
const CONFLICT_REVIEW_TIMEOUT_MS = 90_000;

export interface ConflictFinding {
  /** 涉及的文件（文件名）。项目级问题时为空数组。 */
  sourcePaths: string[];
  /** 矛盾是什么，用业务语言说清。 */
  description: string;
  /** 模型引用的事实依据。 */
  evidence: string[];
}

export interface ConflictReviewResult {
  status: 'success' | 'fallback';
  findings: ConflictFinding[];
  modelCall?: ModelCallDiagnostics;
  error?: string;
}

function documentsBrief(documents: MinimalDocument[]): string {
  if (documents.length === 0) return '项目里还没有已归档的文件。';
  return documents
    .map(document => {
      const facts = document.facts;
      const changes = facts.transactionChanges
        .map(
          change =>
            `${change.field} ${change.before ?? '未写明'} → ${change.after ?? '未写明'}`
        )
        .join('；');
      return [
        `- ${leafName(document.sourcePath)}`,
        `  当前归档阶段：${document.stage ?? '未归档'}`,
        `  类型：${facts.documentType}（原文表述：${facts.rawDocumentType}），标题：${facts.title}`,
        changes ? `  记载的字段变化：${changes}` : '',
        facts.evidenceQuotes.length > 0
          ? `  原文摘录：${facts.evidenceQuotes.slice(0, 2).join('；')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

export function buildConflictReviewPrompt(params: {
  documents: MinimalDocument[];
  timeline: TimelineEntry[];
  projectName?: string;
  stageDefinitions: string;
}): Message[] {
  const systemPrompt = `你在复核一个投资项目的归档结果，任务是找出**自相矛盾**的地方。

【业务阶段的含义】
${params.stageDefinitions}

【复核要求】
1. 只依据下面给出的事实。不要假设项目里应当存在某份没有出现的文件，也不要因为
   某类文件"通常"归在某个阶段就判定当前归档有误。
2. 【数值不同不等于矛盾】不同文件形成于不同时点，同一字段的数值本来就会变化。
   一份文件写 A、另一份写 B，只说明它们记载的是不同时点的状态。只有当两份文件
   对**同一时点**的同一事实给出互斥的说法时，才是矛盾。
3. 【一份文件记录了变更前后值时，别的文件与其中之一吻合是正常的】它恰好说明那份
   文件形成于变更之前或之后，这是相互印证，不是冲突。
   但要接着往下推一步：吻合的是变更**前**值，说明该文件形成于变更之前，那它就
   不应归在变更之后的阶段；吻合的是变更**后**值同理。数值吻合本身不是矛盾，
   吻合所指向的时点与它当前归档的阶段对不上，才是矛盾——这种情况必须报出来。
4. 【文件里约定的将来期限，不是文件的形成时点】某个日期如果是文件约定的、尚未到来的
   期限或截止时点，它说明的是文件约定了什么，而不是文件何时形成，因此不能用它判断
   归档阶段是否正确。日期的含义已在时间线里如实标出，请自行分辨。
5. 【同一条依据不能同时否定两种相反的归档】如果你要用某条事实说明 A 文件归得太晚，
   就不能用同一条事实说明 B 文件归得太早。发现自己在这样做时，说明这条依据不成立。
6. 判断不了就不要报。宁可一条都不报，也不要把"我不确定"或"看起来不太一致"写成矛盾。
7. 每条矛盾必须指名涉及哪些文件，引用支持它的原文事实，并说清为什么它是互斥的、
   而不只是不同。说不清就不要报。
8. 没有发现矛盾时输出空数组。这是正常结果，不是失职。

【输出格式】
只输出一个 JSON 对象，不要输出 Markdown 或说明文字：
{
  "conflicts": [
    {
      "files": ["涉及的文件名"],
      "what": "矛盾是什么，不超过100字",
      "ev": ["支持这条判断的事实，每条不超过60字，最多2条"]
    }
  ]
}`;

  const userPrompt = `【项目】
${params.projectName || '未提供'}

【已归档文件及其事实】
${documentsBrief(params.documents)}

【按日期排列的项目时间线】
${describeTimeline(params.timeline, { showStage: true })}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function stringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function parseConflictReviewResponse(value: string): ConflictFinding[] {
  const json = extractFirstJsonObject(value);
  if (!json) throw new Error('模型响应中没有合法 JSON 对象');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('模型响应中的 JSON 无法解析');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型响应不是 JSON 对象');
  }

  const conflicts = (parsed as Record<string, unknown>).conflicts;
  if (!Array.isArray(conflicts)) return [];

  const findings: ConflictFinding[] = [];
  for (const item of conflicts.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const description =
      typeof record.what === 'string' ? record.what.trim().slice(0, 300) : '';
    if (!description) continue;
    findings.push({
      sourcePaths: stringList(record.files, 10),
      description,
      evidence: stringList(record.ev, 2),
    });
  }
  return findings;
}

/**
 * 跑一次冲突复核。失败时返回空结果并带上错误信息，不影响归档流程。
 */
export async function reviewConflictsWithModel(params: {
  documents: MinimalDocument[];
  timeline: TimelineEntry[];
  projectName?: string;
  stageDefinitions: string;
  customHeaders?: Record<string, string>;
}): Promise<ConflictReviewResult> {
  // 只有一份文件时没有可比对的对象，省掉一次模型调用。
  if (params.documents.length < 2) {
    return { status: 'success', findings: [] };
  }

  let modelCall: ModelCallDiagnostics | undefined;
  try {
    const response = await invokeChatCompletion({
      messages: buildConflictReviewPrompt(params),
      model: CONFLICT_REVIEW_MODEL,
      temperature: 0.1,
      maxOutputTokens: CONFLICT_REVIEW_MAX_OUTPUT_TOKENS,
      customHeaders: params.customHeaders,
      responseFormat: 'json_object',
      timeoutMs: CONFLICT_REVIEW_TIMEOUT_MS,
    });
    modelCall = response.diagnostics;
    return {
      status: 'success',
      findings: parseConflictReviewResponse(response.content),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Conflict review error:', error);
    return {
      status: 'fallback',
      findings: [],
      modelCall,
      error: `冲突复核失败：${message}`,
    };
  }
}
