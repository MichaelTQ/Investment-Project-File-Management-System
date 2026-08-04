import { type Message } from 'coze-coding-dev-sdk';

import {
  getFolderForBusinessStage,
  type ArchiveBusinessStage,
} from '../folder-structure';
import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from './chat-completions';
import { extractFirstJsonObject, type DocumentFacts } from './document-facts';
import type {
  ContextClassificationDecision,
  ProjectContextSnapshot,
  RelatedDocumentFacts,
} from './context-decision';

export const LLM_STAGE_DECISION_MODEL = 'doubao-seed-2-0-mini-260215';
export const LLM_STAGE_DECISION_VERSION = 'llm-stage-decision-v1';
const LLM_STAGE_DECISION_MAX_OUTPUT_TOKENS = 500;
const LLM_STAGE_DECISION_TIMEOUT_MS = 90_000;
const MIN_DECISION_SCORE = 50;

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

const STAGE_GUIDE = `pre_initiation 立项前：项目接触与初步筛选，保密协议、初步介绍材料。
initiation 项目立项：立项申请、立项报告、立项会纪要、立项表决结果、商业计划书、Teaser。
due_diligence 尽职调查：业务/财务/法律/风控尽调报告，以及为尽调收集的底稿资料。
investment_decision 投资决策：上会与决策材料，投资建议书、投委会与专家委员会决议及表决结果、投资合规性审查表，以及作为上会附件的交易前版本章程、营业执照、财务报表、信用报告。
investment_execution 投资实施：交易文件签署与交割，增资协议、股东协议、加入协议、股东会决议、交割确认函、缴款通知书、出资证明书、股东名册、银行回单，以及交易完成后的新版章程。
post_investment 投后管理：投后管理报告、实地调研、被投企业投后定期经营数据。
exit_decision 退出决策：退出方案、退出投委会决议与表决。
exit_execution 退出执行：退出交割、退出价款结算、档案移交。`;

export interface LlmStageDecisionParams {
  sourcePath: string;
  facts: DocumentFacts;
  projectName?: string;
  projectContext?: ProjectContextSnapshot | null;
  relatedDocuments?: RelatedDocumentFacts[];
  customHeaders?: Record<string, string>;
}

export interface LlmStageDecisionResult {
  status: 'success' | 'fallback';
  /** 模型判断失败时为 null，调用方应继续使用规则结论。 */
  decision: ContextClassificationDecision | null;
  modelCall?: ModelCallDiagnostics;
  error?: string;
}

function factsBrief(facts: DocumentFacts): string {
  const lines = [
    `标题：${facts.title}`,
    `模型认定类型：${facts.documentType}（原文表述：${facts.rawDocumentType}）`,
    facts.documentNumber ? `编号：${facts.documentNumber}` : '',
    facts.version ? `版本：${facts.version}` : '',
    `签署状态：${facts.signStatus}`,
    `事实来源：${facts.sourceQuality}，抽取完整度：${facts.extractionConfidence}`,
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
      `交易变化：${facts.transactionChanges
        .map(
          item =>
            `${item.field} ${item.before ?? '未知'} → ${item.after ?? '未知'}`
        )
        .join('；')}`
    );
  }
  if (facts.explicitStageClues.length > 0) {
    lines.push(`业务动作线索：${facts.explicitStageClues.join('；')}`);
  }
  if (facts.evidenceQuotes.length > 0) {
    lines.push(`原文证据：${facts.evidenceQuotes.join('；')}`);
  }
  if (facts.warnings.length > 0) {
    lines.push(`风险提示：${facts.warnings.join('；')}`);
  }
  return lines.join('\n');
}

function projectContextBrief(
  sourcePath: string,
  context: ProjectContextSnapshot | null | undefined
): string {
  if (!context) return '没有可用的项目上下文。';

  const lines = [
    `项目：${context.projectName}`,
    context.targetCompany ? `标的公司：${context.targetCompany}` : '',
    `项目最晚有证据的阶段：${context.latestEvidencedStage}（可信度 ${context.stageConfidence}）`,
  ].filter(Boolean);

  if (context.timeline.length > 0) {
    lines.push('项目事件时间线：');
    for (const event of context.timeline) {
      const marks = event.evidenceFiles.includes(sourcePath)
        ? ' ★该事件直接引用了当前文件'
        : '';
      lines.push(
        `- ${event.date ?? '日期未知'} [${event.stage}] ${event.title}${marks}`
      );
    }
  }
  if (context.conflicts && context.conflicts.length > 0) {
    lines.push(
      `已知冲突：${context.conflicts.map(item => item.description).join('；')}`
    );
  }
  return lines.join('\n');
}

function relatedDocumentsBrief(
  documents: RelatedDocumentFacts[] | undefined
): string {
  if (!documents || documents.length === 0) {
    return '没有提供同项目关联文件。';
  }
  return documents
    .map(item => {
      const changes = item.facts.transactionChanges
        .map(
          change =>
            `${change.field} ${change.before ?? '未知'} → ${change.after ?? '未知'}`
        )
        .join('；');
      return [
        `- ${item.sourcePath}`,
        `  类型：${item.facts.documentType}，标题：${item.facts.title}`,
        changes ? `  交易变化：${changes}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function buildPrompt(params: LlmStageDecisionParams): Message[] {
  const systemPrompt = `你是投资项目档案归档专家。你的任务是根据已经抽取好的文档事实和项目上下文，判断一份文件应当归入哪个业务阶段文件夹。

【可选阶段及其含义】
${STAGE_GUIDE}

【判断原则】
1. 以文档事实和项目时间线为准，不要只看文件名。文件名可能不含任何阶段信息。
2. 同一类文件可能出现在不同阶段，必须结合交易前后状态判断。典型情况：公司章程、营业执照、财务报表既可能是上会附件（investment_decision），也可能是交易完成后的新版本（investment_execution）。注册资本或股东结构出现"由…增加至…"这类变化、或提到"增资后""新增股东"，指向 investment_execution；提到"交易前""增资前""投前""原股东""上会材料"，指向 investment_decision。
3. 项目事件时间线中标记了 ★ 的事件直接引用了当前文件，是最强证据。
4. 关联文件用于旁证，不要把关联文件自身的阶段直接套用到当前文件。
5. 尽量给出最可能的阶段。只有在事实几乎为空、完全无法判断时才输出 unknown。判断有把握但证据不够扎实时，给出阶段并把 review 设为 true。
6. evidence 必须来自上面提供的事实或时间线，不得编造原文。

【输出格式】
只输出一个 JSON 对象，不要输出 Markdown 或说明文字：
{
  "stage": "上述阶段枚举值之一，或 unknown",
  "conf": 0到100的整数，表示归档判断把握程度,
  "review": true或false，是否建议人工复核,
  "why": "判断理由，不超过80字",
  "ev": ["支持该阶段的证据，每条不超过60字，最多3条"],
  "cx": ["与该阶段矛盾或存疑之处，每条不超过60字，最多2条，没有则输出 []"]
}`;

  const userPrompt = `【待归档文件路径】
${params.sourcePath}

【该文件的文档事实】
${factsBrief(params.facts)}

【项目上下文】
${projectContextBrief(params.sourcePath, params.projectContext)}

【同项目关联文件】
${relatedDocumentsBrief(params.relatedDocuments)}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export interface ParsedModelStage {
  stage: ArchiveBusinessStage | null;
  confidence: number;
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

  const rawConfidence = Number(payload.conf);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
    : 0;

  return {
    stage,
    confidence,
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
 * 把模型判断整理成与规则决策相同的结构，便于并排对照和后续切换主导权。
 *
 * 强制人工复核的三条业务规则与规则引擎保持一致：事实抽取完整度过低、
 * 事实仅来自文件名、以及投资合规性审查表一律人工过目。这些是归档合规要求，
 * 不随判断方式改变，因此模型不能通过给高分绕过它们。
 */
function toDecision(
  parsed: ParsedModelStage,
  facts: DocumentFacts
): ContextClassificationDecision {
  const extractionRisk =
    facts.extractionConfidence < 60 || facts.sourceQuality === 'filename_only';
  const policyReview =
    extractionRisk || facts.documentType === 'investment_compliance_review';

  if (!parsed.stage) {
    return {
      status: 'insufficient',
      selectedFolder: null,
      businessStage: null,
      stageConfidence: parsed.confidence,
      routingMethod: 'needs_stage_review',
      confidence: parsed.confidence,
      candidates: [],
      evidence: parsed.evidence,
      contradictions: parsed.contradictions,
      requiresHumanReview: true,
      reasoning: parsed.reasoning,
      policyVersion: LLM_STAGE_DECISION_VERSION,
    };
  }

  const folder = getFolderForBusinessStage(parsed.stage);
  const hasEnoughEvidence = parsed.confidence >= MIN_DECISION_SCORE;

  return {
    status: hasEnoughEvidence ? 'decided' : 'insufficient',
    selectedFolder: hasEnoughEvidence ? folder : null,
    businessStage: parsed.stage,
    stageConfidence: parsed.confidence,
    routingMethod: hasEnoughEvidence ? 'context_policy' : 'needs_stage_review',
    confidence: parsed.confidence,
    candidates: [
      {
        folder,
        score: parsed.confidence,
        evidence: parsed.evidence,
        contradictions: parsed.contradictions,
      },
    ],
    evidence: parsed.evidence,
    contradictions: parsed.contradictions,
    requiresHumanReview: !hasEnoughEvidence || parsed.review || policyReview,
    reasoning: parsed.reasoning,
    policyVersion: LLM_STAGE_DECISION_VERSION,
  };
}

/**
 * 影子模式下的模型阶段判断。失败时返回 decision=null，调用方继续使用规则结论，
 * 因此这个函数不会让分类请求失败。
 */
export async function decideStageWithModel(
  params: LlmStageDecisionParams
): Promise<LlmStageDecisionResult> {
  const messages = buildPrompt(params);
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
      decision: toDecision(
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
