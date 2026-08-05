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

export const CONFLICT_REVIEW_MODEL = 'doubao-seed-2-0-mini-260215';
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
2. 矛盾指的是事实之间对不上，例如：两份文件记载的同一字段数值相互冲突；某文件
   记载的内容与它当前所在阶段的含义不符；同一份文件在不同位置出现且归入了不同阶段。
3. 判断不了就不要报。宁可少报，也不要把"我不确定"写成矛盾。
4. 每条矛盾必须指名涉及哪些文件，并引用支持它的原文事实。
5. 没有发现矛盾时输出空数组。

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
