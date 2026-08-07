import { type Message } from 'coze-coding-dev-sdk';

import {
  SYSTEM_ARCHIVE_FOLDERS,
  type ArchiveBusinessStage,
} from '../folder-structure';
import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from './chat-completions';
import { STAGE_DEFINITIONS } from './llm-stage-decision';
import { describeProjectNotes } from './project-notes';

/**
 * 顶层文件夹判阶段。
 *
 * 用户上传一整个项目档案目录时，判断**只发生在顶层**：根目录之下每一个直接子项各自
 * 判一个阶段，再往下的层级原样保留、一份文件都不读。这是这套流程省时间的全部来源
 * ——佰特微那 56 份财务底稿装在"投资决策"文件夹里，判一次文件夹就够了，不必逐份
 * OCR 加判断。
 *
 * 两条规则，顺序固定：
 * 1. 文件夹名精确等于某个阶段文件夹名 → 直接采用，**不调模型**。用户把文件放进
 *    "投资决策"目录，这本身就是一次明确的人工分类，没有什么可推断的。
 * 2. 否则交模型判，且模型只能回答某个阶段或"无"。答"无"就进「未能区分」，
 *    **不再往下看子层级**——看了也多半判不出（"存货明细表"在尽调和投资决策都可能有），
 *    白花钱不如老实交给人。
 */

export const FOLDER_STAGE_MODEL =
  process.env.FOLDER_STAGE_MODEL?.trim() || 'doubao-seed-2-0-mini-260215';
const FOLDER_STAGE_TIMEOUT_MS = 60_000;
const OUTPUT_TOKENS_PER_FOLDER = 24;
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 2_000;

/** 阶段文件夹的中文名 → 阶段枚举。用于第一条规则的精确匹配。 */
const STAGE_BY_FOLDER_NAME = new Map<string, ArchiveBusinessStage>(
  SYSTEM_ARCHIVE_FOLDERS.map(folder => [folder.name, folder.businessStage])
);

/** 阶段枚举 → 中文名，交给模型时用中文，它对中文阶段名的理解比枚举值稳。 */
const FOLDER_NAME_BY_STAGE = new Map<ArchiveBusinessStage, string>(
  SYSTEM_ARCHIVE_FOLDERS.map(folder => [folder.businessStage, folder.name])
);

export const STAGE_FOLDER_NAMES = [...STAGE_BY_FOLDER_NAME.keys()];

/** 规则一：文件夹名精确等于阶段名。命中就不必调模型。 */
export function matchStageByFolderName(
  folderName: string
): ArchiveBusinessStage | null {
  return STAGE_BY_FOLDER_NAME.get(folderName.trim()) ?? null;
}

export interface FolderStageResult {
  status: 'success' | 'fallback';
  /** 与传入的 folderNames 一一对应；null 表示判不出，进「未能区分」。 */
  stages: Array<ArchiveBusinessStage | null>;
  modelCall?: ModelCallDiagnostics;
  error?: string;
}

export function buildFolderStagePrompt(
  folderNames: string[],
  projectNotes = ''
): Message[] {
  const systemPrompt = `你要判断一批**文件夹的名字**分别属于投资项目档案的哪个业务阶段。

【可选阶段及其含义】
${STAGE_DEFINITIONS}

【要求】
1. 只看文件夹名字本身，不要臆测里面装了什么文件。
2. 【只有名字**只可能**属于一个阶段时才给出阶段】只要你能想到它合理地属于另一个
   阶段，就输出"无"。名字含糊、只是格式或版本的说法（例如"协议word版本""最终版"
   "备份"）一律输出"无"。
   同一个业务词在不同阶段都可能出现——同一份材料既可能是调查阶段收集的，也可能是
   上会时提交的。**分不清是哪一种，就是"无"**，不要按字面最像的那个阶段填。
3. 【输出"无"是正确结果，不是失败】判不出来的会交给人工分类，那比猜错好得多。
   不要为了给每一个都填上答案而勉强选一个最接近的。
4. 阶段名必须原样使用上面列出的中文名，不要输出英文枚举值或其他说法。

【输出格式】
每个文件夹一行，格式为 "序号:阶段名" 或 "序号:无"。不要输出表头、解释、Markdown
或空行。行数必须与输入的文件夹数完全一致。

可用的阶段名只有这些：${STAGE_FOLDER_NAMES.join('、')}`;

  const userPrompt = `${describeProjectNotes(projectNotes)}
【文件夹名】
${folderNames.map((name, index) => `${index + 1}. ${name}`).join('\n')}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 解析逐行输出，按序号回填。
 *
 * 和文件名归一化一样按序号而不是按行序——模型多打少打一行时，按顺序对齐会让后面
 * 所有文件夹集体错位，而每个文件夹背后可能挂着几十份文件。
 */
export function parseFolderStageResponse(
  content: string,
  expectedCount: number
): Array<ArchiveBusinessStage | null> {
  const stages = new Array<ArchiveBusinessStage | null>(expectedCount).fill(null);
  const stageByName = new Map(
    [...FOLDER_NAME_BY_STAGE.entries()].map(([stage, name]) => [name, stage])
  );

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const matched = /^(\d+)\s*[:：]\s*(.+)$/.exec(line);
    if (!matched) continue;
    const index = Number(matched[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) continue;
    const value = matched[2].trim().replace(/^["'「《]|["'」》]$/g, '');
    if (!value || value === '无') continue;
    // 清单以外的说法一律当作判不出，绝不猜。
    stages[index] = stageByName.get(value) ?? null;
  }
  return stages;
}

/**
 * 整批判断文件夹名。失败时全部返回 null——等于全进「未能区分」交给人工，
 * 不会让流程卡住，也不会瞎归档。
 */
export async function classifyFoldersWithModel(params: {
  folderNames: string[];
  projectNotes?: string;
  customHeaders?: Record<string, string>;
}): Promise<FolderStageResult> {
  const { folderNames } = params;
  if (folderNames.length === 0) return { status: 'success', stages: [] };

  let modelCall: ModelCallDiagnostics | undefined;
  try {
    const response = await invokeChatCompletion({
      messages: buildFolderStagePrompt(folderNames, params.projectNotes),
      model: FOLDER_STAGE_MODEL,
      temperature: 0,
      maxOutputTokens: Math.min(
        MAX_OUTPUT_TOKENS,
        Math.max(MIN_OUTPUT_TOKENS, folderNames.length * OUTPUT_TOKENS_PER_FOLDER)
      ),
      customHeaders: params.customHeaders,
      timeoutMs: FOLDER_STAGE_TIMEOUT_MS,
    });
    modelCall = response.diagnostics;
    return {
      status: 'success',
      stages: parseFolderStageResponse(response.content, folderNames.length),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Folder stage classify error:', error);
    return {
      status: 'fallback',
      stages: new Array<ArchiveBusinessStage | null>(folderNames.length).fill(
        null
      ),
      modelCall,
      error: `文件夹判阶段失败：${message}`,
    };
  }
}
