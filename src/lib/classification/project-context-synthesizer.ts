import { Config, LLMClient, type Message } from 'coze-coding-dev-sdk';

import { PROJECT_STAGES, type ProjectStage } from '../project-memory';
import {
  ProjectContextSnapshotSchema,
  type ProjectContextSnapshot,
  type RelatedDocumentFacts,
} from './context-decision';
import { extractFirstJsonObject, type DocumentFacts } from './document-facts';

export const PROJECT_CONTEXT_SYNTHESIZER_VERSION =
  'project-context-synthesizer-v1';
export const PROJECT_CONTEXT_MODEL = 'doubao-seed-2-0-lite-260215';

const MAX_CONTEXT_DOCUMENTS = 100;
const MAX_FACT_CARD_CHARACTERS = 60_000;

interface InvokeClient {
  invoke: LLMClient['invoke'];
}

export interface ProjectContextSynthesisResult {
  status: 'llm_synthesized' | 'deterministic_fallback';
  context: ProjectContextSnapshot;
  llmCallCount: number;
  inputDocumentCount: number;
  includedDocumentCount: number;
  error?: string;
}

export interface SynthesizeProjectContextParams {
  projectName: string;
  documents: RelatedDocumentFacts[];
  previousContext?: ProjectContextSnapshot | null;
  customHeaders?: Record<string, string>;
  client?: InvokeClient;
  allowLlm?: boolean;
}

interface FactCard {
  sourcePath: string;
  documentType: DocumentFacts['documentType'];
  title: string;
  version: string | null;
  dates: DocumentFacts['dates'];
  parties: DocumentFacts['parties'];
  signStatus: DocumentFacts['signStatus'];
  transactionChanges: DocumentFacts['transactionChanges'];
  explicitStageClues: string[];
  evidenceQuotes: string[];
  sourceQuality: DocumentFacts['sourceQuality'];
  extractionConfidence: number;
  warnings: string[];
}

const STAGE_ORDER: ProjectStage[] = [
  'pre_initiation',
  'initiation',
  'due_diligence',
  'investment_decision',
  'investment_execution',
  'post_investment',
  'exit_decision',
  'exit_execution',
];

const DOCUMENT_EVENT_DEFAULTS: Partial<
  Record<
    DocumentFacts['documentType'],
    { eventType: string; stage: ProjectStage; title: string }
  >
> = {
  confidentiality_agreement: {
    eventType: 'confidentiality_agreement_signed',
    stage: 'pre_initiation',
    title: '项目保密协议形成',
  },
  project_initiation_application: {
    eventType: 'project_initiation_requested',
    stage: 'initiation',
    title: '项目提出立项申请',
  },
  project_initiation_report: {
    eventType: 'project_initiation_reviewed',
    stage: 'initiation',
    title: '项目形成立项报告',
  },
  due_diligence_report: {
    eventType: 'due_diligence_completed',
    stage: 'due_diligence',
    title: '项目形成尽职调查报告',
  },
  investment_recommendation: {
    eventType: 'investment_recommendation_formed',
    stage: 'investment_decision',
    title: '项目形成投资建议',
  },
  investment_compliance_review: {
    eventType: 'fund_compliance_review',
    stage: 'investment_decision',
    title: '项目形成投资合规审查意见',
  },
  investment_committee_resolution: {
    eventType: 'investment_committee_approved',
    stage: 'investment_decision',
    title: '投资决策委员会形成决议',
  },
  capital_increase_agreement: {
    eventType: 'capital_increase_agreement_signed',
    stage: 'investment_execution',
    title: '项目形成增资交易协议',
  },
  shareholder_agreement: {
    eventType: 'shareholder_agreement_signed',
    stage: 'investment_execution',
    title: '项目形成股东协议',
  },
  shareholder_resolution: {
    eventType: 'shareholders_approved_transaction',
    stage: 'investment_execution',
    title: '目标公司股东会形成决议',
  },
  board_resolution: {
    eventType: 'board_approved_transaction',
    stage: 'investment_execution',
    title: '目标公司董事会形成决议',
  },
  closing_confirmation: {
    eventType: 'closing_conditions_confirmed',
    stage: 'investment_execution',
    title: '项目交割条件得到确认',
  },
  payment_notice: {
    eventType: 'payment_requested',
    stage: 'investment_execution',
    title: '项目发出投资款支付通知',
  },
  bank_receipt: {
    eventType: 'investment_payment_made',
    stage: 'investment_execution',
    title: '项目形成投资款支付凭证',
  },
  capital_contribution_certificate: {
    eventType: 'capital_contribution_confirmed',
    stage: 'investment_execution',
    title: '项目形成出资证明',
  },
  shareholder_register: {
    eventType: 'shareholder_register_updated',
    stage: 'investment_execution',
    title: '项目形成股东名册',
  },
};

function normalizeSourcePath(sourcePath: string): string {
  return sourcePath.trim().replaceAll('\\', '/').replace(/^\/+/, '');
}

function toFactCard(document: RelatedDocumentFacts): FactCard {
  return {
    sourcePath: normalizeSourcePath(document.sourcePath),
    documentType: document.facts.documentType,
    title: document.facts.title,
    version: document.facts.version,
    dates: document.facts.dates.slice(0, 8),
    parties: document.facts.parties.slice(0, 15),
    signStatus: document.facts.signStatus,
    transactionChanges: document.facts.transactionChanges.slice(0, 12),
    explicitStageClues: document.facts.explicitStageClues.slice(0, 10),
    evidenceQuotes: document.facts.evidenceQuotes.slice(0, 10),
    sourceQuality: document.facts.sourceQuality,
    extractionConfidence: document.facts.extractionConfidence,
    warnings: document.facts.warnings.slice(0, 5),
  };
}

function selectFactCards(documents: RelatedDocumentFacts[]): {
  cards: FactCard[];
  omittedCount: number;
} {
  const cards: FactCard[] = [];
  let currentLength = 2;
  const normalized = documents
    .map(toFactCard)
    .filter(card => card.sourcePath)
    .slice(0, MAX_CONTEXT_DOCUMENTS);

  for (const card of normalized) {
    const encoded = JSON.stringify(card);
    if (cards.length > 0 && currentLength + encoded.length > MAX_FACT_CARD_CHARACTERS) {
      break;
    }
    cards.push(card);
    currentLength += encoded.length + 1;
  }
  return { cards, omittedCount: documents.length - cards.length };
}

function firstMeaningfulDate(facts: DocumentFacts): string | null {
  return facts.dates.find(item => item.date)?.date ?? null;
}

function targetCompanyFromDocuments(
  projectName: string,
  documents: RelatedDocumentFacts[]
): string | null {
  const scores = new Map<string, number>();
  for (const { facts } of documents) {
    for (const party of facts.parties) {
      const role = party.role.toLowerCase();
      const score = /目标公司|项目公司|被投|增资方|公司/.test(role) ? 3 : 1;
      scores.set(party.name, (scores.get(party.name) ?? 0) + score);
    }
  }
  return (
    [...scores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
    (projectName.trim() || null)
  );
}

function deterministicContext(
  projectName: string,
  documents: RelatedDocumentFacts[],
  warnings: string[]
): ProjectContextSnapshot {
  const timeline = documents.flatMap(document => {
    const definition = DOCUMENT_EVENT_DEFAULTS[document.facts.documentType];
    if (!definition || document.facts.extractionConfidence < 40) return [];
    const evidence =
      document.facts.evidenceQuotes[0] ??
      document.facts.explicitStageClues[0] ??
      `${document.facts.title}被识别为${document.facts.rawDocumentType}`;
    return [
      {
        date: firstMeaningfulDate(document.facts),
        ...definition,
        evidenceFiles: [normalizeSourcePath(document.sourcePath)],
        evidence: evidence.slice(0, 1000),
        confidence:
          document.facts.extractionConfidence >= 80
            ? ('high' as const)
            : ('medium' as const),
        needsHumanConfirmation:
          document.facts.extractionConfidence < 60 ||
          document.facts.sourceQuality === 'filename_only',
      },
    ];
  });
  const evidencedStages = timeline.map(event => event.stage);
  const latestEvidencedStage =
    [...STAGE_ORDER]
      .reverse()
      .find(stage => evidencedStages.includes(stage)) ?? 'unknown';
  const stageDocuments = new Map<ProjectStage, string[]>();
  for (const event of timeline) {
    stageDocuments.set(event.stage, [
      ...(stageDocuments.get(event.stage) ?? []),
      ...event.evidenceFiles,
    ]);
  }
  const stageHypotheses = [...stageDocuments.entries()].map(
    ([stage, evidenceFiles]) => ({
      stage,
      confidence: 'medium' as const,
      evidenceFiles: [...new Set(evidenceFiles)],
      reasoning: `现有文件中发现 ${evidenceFiles.length} 条与该阶段相关的结构化事件证据。`,
    })
  );

  return ProjectContextSnapshotSchema.parse({
    schemaVersion: 1,
    projectName: projectName.trim() || '未命名项目',
    targetCompany: targetCompanyFromDocuments(projectName, documents),
    contextStatus: 'deterministic_fallback',
    latestEvidencedStage,
    stageConfidence: timeline.length > 0 ? 'medium' : 'low',
    importantCaveat:
      '项目阶段是基于现有文件证据形成的暂定快照，不能把上传顺序或最晚阶段直接当作单份文件的归档阶段。',
    timeline,
    stageHypotheses,
    documentRelations: [],
    conflicts: [],
    openQuestions:
      timeline.length > 0
        ? []
        : ['现有文件尚未形成可核实的项目事件，需要继续补充材料或人工确认。'],
    sourceDocumentCount: documents.length,
    generatedAt: new Date().toISOString(),
    synthesizerVersion: PROJECT_CONTEXT_SYNTHESIZER_VERSION,
    synthesisWarnings: warnings,
  });
}

export function buildProjectContextPrompt(params: {
  projectName: string;
  factCards: FactCard[];
  previousContext?: ProjectContextSnapshot | null;
}): Message[] {
  const systemPrompt = `你是投资项目档案的“项目上下文综合器”。

你要根据多份文件的结构化事实，重建项目事件时间线、阶段假设、文件关系、冲突和待确认问题。你不负责选择归档文件夹，也不能把文件上传顺序当作业务发生顺序。

规则：
1. 只能使用输入事实，不得凭常识补造交易、日期、签署或付款事实。
2. 每个 timeline 事件必须引用至少一个输入中存在的 sourcePath。
3. 日期无法确认时 date 输出 null，不要猜日期。
4. latestEvidencedStage 表示现有证据能够支持的最晚阶段，不代表每份文件都属于该阶段。
5. 同一事件可合并多份文件证据；交易前后版本应建立 documentRelations。
6. 发现日期、金额、股东或阶段矛盾时写入 conflicts，不要强行消解。
7. stageHypotheses、documentRelations、conflicts、timeline、openQuestions 始终输出数组。
8. confidence 只能是 low、medium、high。
9. stage 只能是：${PROJECT_STAGES.join(', ')}。

只输出一个严格 JSON 对象，结构如下：
{
  "schemaVersion": 1,
  "projectName": "项目名称",
  "targetCompany": "目标公司或null",
  "contextStatus": "llm_synthesized",
  "latestEvidencedStage": "阶段枚举",
  "stageConfidence": "low|medium|high",
  "importantCaveat": "关键限制",
  "timeline": [{"date":"YYYY-MM-DD或null","eventType":"稳定英文事件类型","stage":"阶段枚举","title":"事件标题","evidenceFiles":["精确sourcePath"],"evidence":"证据摘要","confidence":"low|medium|high","needsHumanConfirmation":false}],
  "stageHypotheses": [{"stage":"阶段枚举","confidence":"low|medium|high","evidenceFiles":["精确sourcePath"],"reasoning":"依据"}],
  "documentRelations": [{"fromSourcePath":"精确sourcePath","toSourcePath":"精确sourcePath","relationType":"关系类型","evidence":"关系依据","confidence":"low|medium|high"}],
  "conflicts": [{"description":"冲突说明","evidenceFiles":["精确sourcePath"],"needsHumanConfirmation":true}],
  "openQuestions": ["仍缺少的证据或需要确认的问题"]
}`;

  const userPrompt = `项目名称：${params.projectName || '未命名项目'}

当前全部有效文件事实卡片：
${JSON.stringify(params.factCards)}

上一版项目快照仅供核对，不得保留已经失去文件证据的结论：
${params.previousContext ? JSON.stringify(params.previousContext) : '[无上一版快照]'}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function validateEvidenceReferences(
  context: ProjectContextSnapshot,
  documents: RelatedDocumentFacts[],
  omittedCount: number
): ProjectContextSnapshot {
  const validPaths = new Set(
    documents.map(document => normalizeSourcePath(document.sourcePath))
  );
  const validEvidenceFiles = (paths: string[]) =>
    [...new Set(paths.map(normalizeSourcePath).filter(path => validPaths.has(path)))];
  const warnings = new Set(context.synthesisWarnings ?? []);
  if (omittedCount > 0) {
    warnings.add(`本轮上下文预算未包含 ${omittedCount} 份文件，项目快照可能不完整`);
  }
  const timeline = context.timeline.flatMap(event => {
    const evidenceFiles = validEvidenceFiles(event.evidenceFiles);
    if (evidenceFiles.length === 0) {
      warnings.add(`已丢弃缺少有效来源文件的项目事件：${event.title}`);
      return [];
    }
    return [{ ...event, evidenceFiles }];
  });
  const stageHypotheses = (context.stageHypotheses ?? []).flatMap(hypothesis => {
    const evidenceFiles = validEvidenceFiles(hypothesis.evidenceFiles);
    return evidenceFiles.length > 0 ? [{ ...hypothesis, evidenceFiles }] : [];
  });
  const documentRelations = (context.documentRelations ?? []).filter(
    relation =>
      validPaths.has(normalizeSourcePath(relation.fromSourcePath)) &&
      validPaths.has(normalizeSourcePath(relation.toSourcePath)) &&
      normalizeSourcePath(relation.fromSourcePath) !==
        normalizeSourcePath(relation.toSourcePath)
  );
  const conflicts = (context.conflicts ?? []).flatMap(conflict => {
    const evidenceFiles = validEvidenceFiles(conflict.evidenceFiles);
    return evidenceFiles.length > 0 ? [{ ...conflict, evidenceFiles }] : [];
  });

  return ProjectContextSnapshotSchema.parse({
    ...context,
    contextStatus: 'llm_synthesized',
    timeline,
    stageHypotheses,
    documentRelations,
    conflicts,
    sourceDocumentCount: documents.length,
    generatedAt: new Date().toISOString(),
    synthesizerVersion: PROJECT_CONTEXT_SYNTHESIZER_VERSION,
    synthesisWarnings: [...warnings],
  });
}

export async function synthesizeProjectContext(
  params: SynthesizeProjectContextParams
): Promise<ProjectContextSynthesisResult> {
  const documents = params.documents
    .map(document => ({
      ...document,
      sourcePath: normalizeSourcePath(document.sourcePath),
    }))
    .filter(document => document.sourcePath);
  const { cards, omittedCount } = selectFactCards(documents);
  const allowLlm = params.allowLlm ?? Boolean(params.client || params.customHeaders);

  if (!allowLlm || cards.length === 0) {
    const warning =
      cards.length === 0
        ? '当前没有可用于综合项目上下文的有效文件事实'
        : '本轮未调用项目上下文大模型，使用确定性事实事件作为降级快照';
    return {
      status: 'deterministic_fallback',
      context: deterministicContext(params.projectName, documents, [warning]),
      llmCallCount: 0,
      inputDocumentCount: documents.length,
      includedDocumentCount: cards.length,
    };
  }

  const client =
    params.client ?? new LLMClient(new Config(), params.customHeaders ?? {});
  try {
    const response = await client.invoke(
      buildProjectContextPrompt({
        projectName: params.projectName,
        factCards: cards,
        previousContext: params.previousContext,
      }),
      { model: PROJECT_CONTEXT_MODEL, temperature: 0.1 }
    );
    const json = extractFirstJsonObject(response.content);
    if (!json) throw new Error('项目上下文响应中没有 JSON 对象');
    const parsed = ProjectContextSnapshotSchema.parse(JSON.parse(json));
    return {
      status: 'llm_synthesized',
      context: validateEvidenceReferences(parsed, documents, omittedCount),
      llmCallCount: 1,
      inputDocumentCount: documents.length,
      includedDocumentCount: cards.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Project context synthesis error:', error);
    return {
      status: 'deterministic_fallback',
      context: deterministicContext(params.projectName, documents, [
        `项目上下文大模型综合失败：${message}`,
      ]),
      llmCallCount: 1,
      inputDocumentCount: documents.length,
      includedDocumentCount: cards.length,
      error: message,
    };
  }
}
