import { type Message } from 'coze-coding-dev-sdk';

import {
  getFolderForBusinessStage,
  type ArchiveBusinessStage,
} from '../folder-structure';
import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from './chat-completions';
import {
  extractFirstJsonObject,
  hasContentEvidence,
  type DocumentFacts,
} from './document-facts';
import type { ContextClassificationDecision } from './minimal/types';
import { leafName } from './source-path';

export const LLM_STAGE_DECISION_MODEL = 'doubao-seed-2-0-mini-260215';
export const LLM_STAGE_DECISION_VERSION = 'llm-stage-decision-v2';
const LLM_STAGE_DECISION_MAX_OUTPUT_TOKENS = 500;
const LLM_STAGE_DECISION_TIMEOUT_MS = 90_000;

const STAGE_VALUES: ArchiveBusinessStage[] = [
  'pre_initiation',
  'initiation',
  'due_diligence',
  'investment_decision',
  'investment_execution',
  'post_investment',
  'exit_decision',
  'exit_execution',
];

/**
 * 业务阶段的定义。这是代码里唯一保留的业务描述，因为归档目录本身就是按这套
 * 阶段划分的——不告诉模型每个阶段是什么意思，它无从判断。
 *
 * 刻意**不列举**每个阶段常见的文件类型。曾经有一版列了清单（"立项申请、立项
 * 报告、立项会纪要…"），它会让模型跳过推理直接查表：清单上有的判得准，清单上
 * 没有的一律判错，且系统无法泛化到没见过的文件。
 */
export const STAGE_DEFINITIONS = `pre_initiation 立项前：与项目方初步接触、建立保密安排、获取初步介绍材料的阶段。此时尚未走内部立项程序。
initiation 项目立项：正式启动项目、走内部立项审批的阶段。文件反映的是"决定投入资源开展调查"这一内部决策过程本身。
due_diligence 尽职调查：对标的开展业务、财务、法律、风控核查的阶段。文件反映的是对标的的调查与核实，以及为核查而收集的标的方原始资料。
investment_decision 投资决策：内部作出投或不投决定的阶段。文件反映的是提交决策机构审议的材料与决策结论，以及审议时所依据的、交易发生之前的标的状态。
investment_execution 投资实施：交易文件正式签署、条件交割、投资款支付的阶段。文件反映的是交易已经发生这一事实状态。
post_investment 投后管理：投资完成后持续跟踪被投企业的阶段。
exit_decision 退出决策：内部决定是否退出、如何退出的阶段。
exit_execution 退出执行：退出交易实际完成的阶段。`;

export interface LlmStageDecisionParams {
  sourcePath: string;
  facts: DocumentFacts;
  projectName?: string;
  /** 同项目其他文件的事实，供模型自行比对。代码不做任何预处理和结论。 */
  relatedDocuments?: Array<{ sourcePath: string; facts: DocumentFacts }>;
  /** 按日期排好的项目时间线文本。 */
  timeline?: string;
  customHeaders?: Record<string, string>;
}

export interface LlmStageDecisionResult {
  status: 'success' | 'fallback';
  decision: ContextClassificationDecision | null;
  modelCall?: ModelCallDiagnostics;
  error?: string;
}

/** 把一份文件的事实原样铺开。不筛选、不排序、不强调任何字段。 */
function factsBrief(facts: DocumentFacts): string {
  const lines = [
    `标题：${facts.title}`,
    `类型：${facts.documentType}（原文表述：${facts.rawDocumentType}）`,
    facts.documentNumber ? `编号：${facts.documentNumber}` : '',
    facts.version ? `版本：${facts.version}` : '',
    `签署状态：${facts.signStatus}`,
    `事实来源：${facts.sourceQuality}`,
  ].filter(Boolean);

  if (facts.dates.length > 0) {
    lines.push(
      `日期：${facts.dates
        .map(item => `${item.date ?? '未知'}（${item.meaning}）`)
        .join('；')}`
    );
  }
  if (facts.parties.length > 0) {
    lines.push(
      `主体：${facts.parties.map(item => `${item.name}[${item.role}]`).join('；')}`
    );
  }
  if (facts.transactionChanges.length > 0) {
    lines.push(
      `记载的字段变化：${facts.transactionChanges
        .map(
          item =>
            `${item.field} ${item.before ?? '未写明'} → ${item.after ?? '未写明'}`
        )
        .join('；')}`
    );
  }
  if (facts.explicitStageClues.length > 0) {
    lines.push(`业务动作：${facts.explicitStageClues.join('；')}`);
  }
  if (facts.evidenceQuotes.length > 0) {
    lines.push(`原文摘录：${facts.evidenceQuotes.join('；')}`);
  }
  if (facts.warnings.length > 0) {
    lines.push(`抽取提示：${facts.warnings.join('；')}`);
  }
  return lines.join('\n');
}

function relatedDocumentsBrief(
  documents: LlmStageDecisionParams['relatedDocuments']
): string {
  if (!documents || documents.length === 0) {
    return '项目里还没有其他文件。';
  }

  return documents
    .map(item => {
      const changes = item.facts.transactionChanges
        .map(
          change =>
            `${change.field} ${change.before ?? '未写明'} → ${change.after ?? '未写明'}`
        )
        .join('；');
      const quotes = item.facts.evidenceQuotes.slice(0, 2);
      return [
        `- ${leafName(item.sourcePath)}`,
        `  类型：${item.facts.documentType}，标题：${item.facts.title}`,
        changes ? `  记载的字段变化：${changes}` : '',
        quotes.length > 0 ? `  原文摘录：${quotes.join('；')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

export function buildStageDecisionPrompt(
  params: LlmStageDecisionParams
): Message[] {
  const systemPrompt = `你是投资项目档案归档专家。根据已经抽取好的文档事实和项目时间线，判断一份文件应当归入哪个业务阶段。

【可选阶段及其含义】
${STAGE_DEFINITIONS}

【判断要求】
1. 只依据下面给出的事实和时间线。文件名可能不含任何阶段信息，不要单凭文件名判断。
2. 不要假设项目里应当存在某份没有出现的文件，也不要因为某类文件"通常"归在某个阶段就照此归档。判断依据必须来自这份文件自身记载的内容。
3. 项目已经走到哪一步，不代表当前文件属于哪一步——较早形成的文件依然属于更早的阶段。
4. 【其他文件的归档位置可以参考，但不能作为唯一依据】时间线里标注"人工确认归入某阶段"的，是人工确认过的归档结果，属于可信信息。但它说明的是那份文件的归属，不能直接推出本文件的归属——同一个项目里的文件本来就分属不同阶段。不得只凭"其他文件已归入某阶段"就判定本文件同属该阶段；必须结合本文件自身记载的内容（日期、数值、业务动作）说明为什么它属于这个阶段。
5. evidence 必须引用上面提供的事实原文，不得编造。
6. 事实不足以判断时输出 unknown，并在 why 里说明是哪些信息读不到。不要为了给出结论而猜测。
7. 存在任何存疑之处时把 review 设为 true。

【输出格式】
只输出一个 JSON 对象，不要输出 Markdown 或说明文字：
{
  "stage": "上述阶段枚举值之一，或 unknown",
  "review": true或false，是否建议人工复核,
  "why": "判断理由，不超过80字",
  "ev": ["支持该阶段的事实，每条不超过60字，最多3条"],
  "cx": ["存疑或与该阶段不符之处，每条不超过60字，最多2条，没有则输出 []"]
}`;

  const userPrompt = `【待归档文件名】
${leafName(params.sourcePath)}

【该文件的文档事实】
${factsBrief(params.facts)}

【同项目其他文件的事实】
${relatedDocumentsBrief(params.relatedDocuments)}

【按日期排列的项目时间线】
${params.timeline || '项目里还没有带日期的文件。'}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export interface ParsedModelStage {
  stage: ArchiveBusinessStage | null;
  review: boolean;
  reasoning: string;
  evidence: string[];
  contradictions: string[];
}

function stringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function parseLlmStageDecisionResponse(value: string): ParsedModelStage {
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

  const payload = parsed as Record<string, unknown>;
  const rawStage = typeof payload.stage === 'string' ? payload.stage.trim() : '';
  const stage = STAGE_VALUES.includes(rawStage as ArchiveBusinessStage)
    ? (rawStage as ArchiveBusinessStage)
    : null;
  if (!stage && rawStage !== 'unknown' && rawStage !== '') {
    throw new Error(`模型返回了未知阶段：${rawStage.slice(0, 40)}`);
  }

  return {
    stage,
    review: payload.review === true,
    reasoning:
      typeof payload.why === 'string' && payload.why.trim()
        ? payload.why.trim().slice(0, 200)
        : '模型未给出理由。',
    evidence: stringList(payload.ev, 3),
    contradictions: stringList(payload.cx, 2),
  };
}

/**
 * 整理成统一结构。
 *
 * 这里只剩两条规则，都与业务无关：模型自己说要复核、或它自己写下了存疑之处，
 * 就转人工。原先还有"投资合规性审查表一律人工过目""抽取完整度低于 60 分"等
 * 判断，前者是业务预设，后者是拍脑袋定的阈值，已删除。
 *
 * 事实完全读不到（只有文件名）时同样转人工——这一条是数据质量判断，不涉及
 * 任何业务知识。
 */
export function buildDecisionFromParsed(
  parsed: ParsedModelStage,
  facts: DocumentFacts
): ContextClassificationDecision {
  // 以有没有原文事实为准。模型自报的 sourceQuality 会与它自己的产出矛盾，
  // 只信自报会把一批读到了内容的文件误判成"读不到"。
  const unreadable =
    facts.sourceQuality === 'filename_only' && !hasContentEvidence(facts);
  const requiresHumanReview =
    !parsed.stage ||
    parsed.review ||
    parsed.contradictions.length > 0 ||
    unreadable;

  return {
    status: parsed.stage ? 'decided' : 'insufficient',
    selectedFolder: parsed.stage ? getFolderForBusinessStage(parsed.stage) : null,
    businessStage: parsed.stage,
    evidence: parsed.evidence,
    contradictions: parsed.contradictions,
    requiresHumanReview,
    reasoning: parsed.reasoning,
    policyVersion: LLM_STAGE_DECISION_VERSION,
  };
}

export async function decideStageWithModel(
  params: LlmStageDecisionParams
): Promise<LlmStageDecisionResult> {
  const messages = buildStageDecisionPrompt(params);
  let modelCall: ModelCallDiagnostics | undefined;

  try {
    const response = await invokeChatCompletion({
      messages,
      model: LLM_STAGE_DECISION_MODEL,
      temperature: 0.1,
      maxOutputTokens: LLM_STAGE_DECISION_MAX_OUTPUT_TOKENS,
      customHeaders: params.customHeaders,
      responseFormat: 'json_object',
      timeoutMs: LLM_STAGE_DECISION_TIMEOUT_MS,
    });
    modelCall = response.diagnostics;
    return {
      status: 'success',
      decision: buildDecisionFromParsed(
        parseLlmStageDecisionResponse(response.content),
        params.facts
      ),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('LLM stage decision error:', error);
    const truncated = modelCall?.finishReason === 'length';
    return {
      status: 'fallback',
      decision: null,
      modelCall,
      error: truncated
        ? `模型阶段判断失败：输出达到 ${LLM_STAGE_DECISION_MAX_OUTPUT_TOKENS} tokens 上限被截断（${message}）`
        : `模型阶段判断失败：${message}`,
    };
  }
}
