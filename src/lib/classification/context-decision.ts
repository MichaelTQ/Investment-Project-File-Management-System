import { z } from 'zod';

import {
  FLAT_FILE_CATEGORIES,
  type FlatFileCategory,
} from '../folder-structure';
import { PROJECT_STAGES } from '../project-memory';
import { getCategoryEvidencePolicy } from './category-policies';
import {
  DocumentFactsSchema,
  type DocumentFacts,
} from './document-facts';

const ConfidenceLabelSchema = z.enum(['low', 'medium', 'high']);

export const ProjectTimelineEventSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  eventType: z.string().trim().min(1).max(128),
  stage: z.enum(PROJECT_STAGES),
  title: z.string().trim().min(1).max(300),
  evidenceFiles: z.array(z.string().trim().min(1).max(1024)).max(100),
  evidence: z.string().trim().min(1).max(1000),
  confidence: ConfidenceLabelSchema,
  needsHumanConfirmation: z.boolean().optional(),
});

export const ProjectContextSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  projectName: z.string().trim().min(1).max(200),
  targetCompany: z.string().trim().min(1).max(300).nullable().optional(),
  contextStatus: z.string().trim().min(1).max(100),
  latestEvidencedStage: z.enum(PROJECT_STAGES),
  stageConfidence: ConfidenceLabelSchema,
  importantCaveat: z.string().trim().max(1000).optional(),
  timeline: z.array(ProjectTimelineEventSchema).max(200),
  openQuestions: z.array(z.string().trim().min(1).max(1000)).max(100),
});

export const RelatedDocumentFactsSchema = z.object({
  sourcePath: z.string().trim().min(1).max(1024),
  facts: DocumentFactsSchema,
});

export type ProjectContextSnapshot = z.infer<
  typeof ProjectContextSnapshotSchema
>;
export type RelatedDocumentFacts = z.infer<typeof RelatedDocumentFactsSchema>;

export interface ContextCandidateScore {
  category: FlatFileCategory;
  score: number;
  evidence: string[];
  contradictions: string[];
}

export interface ContextClassificationDecision {
  status: 'decided' | 'insufficient' | 'conflict';
  selectedCategory: FlatFileCategory | null;
  confidence: number;
  candidates: ContextCandidateScore[];
  evidence: string[];
  contradictions: string[];
  requiresHumanReview: boolean;
  reasoning: string;
  policyVersion: string;
}

export interface DecideWithProjectContextParams {
  sourcePath: string;
  facts: DocumentFacts;
  projectContext?: ProjectContextSnapshot | null;
  relatedDocuments?: RelatedDocumentFacts[];
}

interface MutableCandidate {
  category: FlatFileCategory;
  score: number;
  evidence: string[];
  contradictions: string[];
}

const POLICY_VERSION = 'context-decision-v2';
const MIN_DECISION_SCORE = 50;
const MIN_SCORE_GAP = 15;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function findCategory(
  folderId: string,
  fileName: string
): FlatFileCategory {
  const category = FLAT_FILE_CATEGORIES.find(
    item => item.folderId === folderId && item.fileName === fileName
  );
  if (!category) {
    throw new Error(`上下文规则引用了不存在的类别：${folderId}/${fileName}`);
  }
  return category;
}

function addEvidence(
  candidate: MutableCandidate,
  score: number,
  evidence: string
): void {
  candidate.score += score;
  if (!candidate.evidence.includes(evidence)) candidate.evidence.push(evidence);
}

function addContradiction(
  candidate: MutableCandidate,
  score: number,
  contradiction: string
): void {
  candidate.score -= score;
  if (!candidate.contradictions.includes(contradiction)) {
    candidate.contradictions.push(contradiction);
  }
}

function combinedFactsText(facts: DocumentFacts): string {
  return [
    facts.title,
    facts.rawDocumentType,
    facts.version ?? '',
    ...facts.explicitStageClues,
    ...facts.evidenceQuotes,
    ...facts.transactionChanges.flatMap(change => [
      change.field,
      change.before ?? '',
      change.after ?? '',
      change.evidence,
    ]),
  ].join('\n');
}

function hasAny(value: string, terms: string[]): boolean {
  return terms.some(term => value.includes(term));
}

function meaningfulDocumentDate(facts: DocumentFacts): string | null {
  const meaningfulTerms = ['签署', '批准', '通过', '修订', '修改', '生效', '形成'];
  return (
    facts.dates.find(
      item => item.date && hasAny(item.meaning, meaningfulTerms)
    )?.date ?? null
  );
}

function extractRegisteredCapital(facts: DocumentFacts): number | null {
  const explicitTexts = [
    ...facts.transactionChanges
      .filter(change => change.field.includes('注册资本'))
      .flatMap(change => [change.after ?? '', change.before ?? '']),
    ...facts.evidenceQuotes.filter(quote => quote.includes('注册资本')),
  ];

  const explicitAmounts = explicitTexts.flatMap(value => {
    const explicitMatches = Array.from(
      value.matchAll(/注册资本[^\d]{0,30}([\d,.]+)/g)
    );
    const amountMatches = Array.from(
      value.matchAll(/([\d,.]+)\s*万元/g)
    );
    return [...explicitMatches, ...amountMatches]
      .map(match => Number(match[1].replaceAll(',', '')))
      .filter(Number.isFinite);
  });
  let contributionAmounts = facts.evidenceQuotes
    .filter(quote => quote.includes('认缴出资额'))
    .flatMap(quote =>
      Array.from(quote.matchAll(/([\d,.]+)\s*万元/g)).map(match =>
        Number(match[1].replaceAll(',', ''))
      )
    )
    .filter(Number.isFinite);
  if (contributionAmounts.length > 0 && contributionAmounts.length % 2 === 0) {
    const half = contributionAmounts.length / 2;
    const duplicatedSequence = contributionAmounts
      .slice(0, half)
      .every(
        (amount, index) =>
          Math.abs(amount - contributionAmounts[index + half]) < 0.000001
      );
    if (duplicatedSequence) contributionAmounts = contributionAmounts.slice(0, half);
  }
  const contributionTotal = contributionAmounts.reduce(
    (sum, amount) => sum + amount,
    0
  );
  if (explicitAmounts.length > 0) return Math.max(...explicitAmounts);
  return contributionTotal > 0 ? contributionTotal : null;
}

function parseAmount(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/[\d,.]+/);
  if (!match) return null;
  const amount = Number(match[0].replaceAll(',', ''));
  return Number.isFinite(amount) ? amount : null;
}

function extractRegisteredCapitalTransition(facts: DocumentFacts): {
  before: number;
  after: number;
} | null {
  for (const change of facts.transactionChanges) {
    if (!change.field.includes('注册资本')) continue;
    const before = parseAmount(change.before);
    const after = parseAmount(change.after);
    if (before !== null && after !== null && before !== after) {
      return { before, after };
    }
  }

  const text = combinedFactsText(facts);
  const match = text.match(
    /注册资本由(?:人民币)?\s*([\d,.]+)\s*万元\s*(?:增加至|增至|变更为)(?:人民币)?\s*([\d,.]+)\s*万元/
  );
  if (!match) return null;
  const before = Number(match[1].replaceAll(',', ''));
  const after = Number(match[2].replaceAll(',', ''));
  return Number.isFinite(before) && Number.isFinite(after) && before !== after
    ? { before, after }
    : null;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.00001, Math.abs(right) * 0.0001);
}

function createCandidate(
  folderId: string,
  fileName: string,
  baseScore: number
): MutableCandidate {
  return {
    category: findCategory(folderId, fileName),
    score: baseScore,
    evidence: [],
    contradictions: [],
  };
}

function scoreCompanyCharter(
  params: DecideWithProjectContextParams
): MutableCandidate[] {
  const decision = createCandidate('decision-meeting', '公司章程', 20);
  const execution = createCandidate(
    'investment-implementation',
    '项目公司章程',
    20
  );
  const text = combinedFactsText(params.facts);
  const executionTerms = [
    '增资后',
    '新增股东',
    '增加至',
    '本次增资',
  ];
  const preTransactionTerms = [
    '交易前',
    '增资前',
    '投前',
    '原股东',
    '尽调材料',
    '上会材料',
  ];

  if (hasAny(text, executionTerms)) {
    addEvidence(
      execution,
      35,
      '章程事实包含增资、股东变化或章程修改等投资实施证据'
    );
    addContradiction(
      decision,
      20,
      '文件包含交易完成方向的章程修改证据，不像交易前上会材料'
    );
  }
  if (hasAny(text, preTransactionTerms)) {
    addEvidence(
      decision,
      35,
      '章程事实明确指向交易前、投前或上会材料状态'
    );
    addContradiction(
      execution,
      15,
      '文件明确描述交易前状态，不足以证明投资实施版本'
    );
  }

  const capitalChanges = params.facts.transactionChanges.filter(change =>
    change.field.includes('注册资本')
  );
  if (
    capitalChanges.some(change => change.before && change.after) ||
    params.facts.transactionChanges.some(change =>
      hasAny(change.field, ['股东', '持股', '股权'])
    )
  ) {
    addEvidence(
      execution,
      25,
      '结构化事实记录了注册资本或股东结构的交易变化'
    );
  }

  const matchingEvents = params.projectContext?.timeline.filter(event =>
    event.evidenceFiles.includes(params.sourcePath)
  ) ?? [];
  for (const event of matchingEvents) {
    if (event.stage === 'investment_execution') {
      addEvidence(
        execution,
        30,
        `项目事件“${event.title}”将该文件关联到投资实施阶段`
      );
    } else if (
      event.stage === 'investment_decision' ||
      event.stage === 'due_diligence'
    ) {
      addEvidence(
        decision,
        30,
        `项目事件“${event.title}”将该文件关联到交易前阶段`
      );
    }
  }

  const documentDate = meaningfulDocumentDate(params.facts);
  const approvalDate = params.projectContext?.timeline.find(
    event => event.eventType === 'shareholders_approved_transaction'
  )?.date;
  if (documentDate && approvalDate) {
    if (documentDate >= approvalDate) {
      addEvidence(
        execution,
        15,
        `章程有效日期 ${documentDate} 不早于股东会批准交易日期 ${approvalDate}`
      );
    } else {
      addEvidence(
        decision,
        15,
        `章程有效日期 ${documentDate} 早于股东会批准交易日期 ${approvalDate}`
      );
    }
  }

  const currentCapital = extractRegisteredCapital(params.facts);
  const relatedCharters = (params.relatedDocuments ?? []).filter(
    item => item.facts.documentType === 'company_charter'
  );
  const relatedCapitals = relatedCharters
    .map(item => ({
      sourcePath: item.sourcePath,
      amount: extractRegisteredCapital(item.facts),
    }))
    .filter(
      item => item.amount !== null
    ) as Array<{ sourcePath: string; amount: number }>;

  if (currentCapital !== null && relatedCapitals.length > 0) {
    const higher = relatedCapitals.find(item => item.amount > currentCapital);
    const lower = relatedCapitals.find(item => item.amount < currentCapital);
    if (higher) {
      addEvidence(
        decision,
        30,
        `项目内关联章程“${higher.sourcePath}”注册资本更高，当前文件更可能是交易前版本`
      );
    }
    if (lower) {
      addEvidence(
        execution,
        30,
        `项目内关联章程“${lower.sourcePath}”注册资本更低，当前文件更可能是增资后版本`
      );
    }
  }

  const transactionEvidence = (params.relatedDocuments ?? [])
    .filter(item =>
      ['shareholder_resolution', 'capital_increase_agreement'].includes(
        item.facts.documentType
      )
    )
    .map(item => ({
      sourcePath: item.sourcePath,
      transition: extractRegisteredCapitalTransition(item.facts),
    }))
    .find(item => item.transition !== null);
  if (currentCapital !== null && transactionEvidence?.transition) {
    if (approximatelyEqual(currentCapital, transactionEvidence.transition.after)) {
      addEvidence(
        execution,
        30,
        `关联交易文件“${transactionEvidence.sourcePath}”确认注册资本由 ${transactionEvidence.transition.before} 万元增至 ${transactionEvidence.transition.after} 万元，当前章程与增资后资本一致`
      );
    } else if (
      approximatelyEqual(currentCapital, transactionEvidence.transition.before)
    ) {
      addEvidence(
        decision,
        30,
        `关联交易文件“${transactionEvidence.sourcePath}”确认交易前注册资本为 ${transactionEvidence.transition.before} 万元，当前章程与交易前资本一致`
      );
    }
  }

  if (params.projectContext?.latestEvidencedStage === 'investment_execution') {
    addEvidence(
      execution,
      5,
      '项目已有投资实施事件；该信息只作为弱先验，不能单独决定历史文件阶段'
    );
  }

  return [decision, execution];
}

function scoreInvestmentComplianceReview(
  params: DecideWithProjectContextParams
): MutableCandidate[] {
  const candidate = createCandidate(
    'decision-meeting',
    '投资合规性审查表',
    35
  );
  const text = combinedFactsText(params.facts);

  if (
    hasAny(text, [
      '投资项目合规性审查表',
      '投资合规性审查表',
      '合规性审查表',
    ])
  ) {
    addEvidence(candidate, 30, '文件正式标题或文档类型明确为投资合规性审查表');
  }
  if (
    hasAny(text, [
      '子基金管理人意见',
      '子基金管理人合规',
      '投资限制',
      '禁止事项',
      '关联交易',
    ])
  ) {
    addEvidence(candidate, 20, '正文包含基金管理人的项目级合规审查结构或结论');
  }

  const matchingEvent = params.projectContext?.timeline.find(
    event =>
      event.eventType === 'fund_compliance_review' &&
      event.evidenceFiles.includes(params.sourcePath)
  );
  if (matchingEvent) {
    addEvidence(
      candidate,
      15,
      `项目事件“${matchingEvent.title}”与当前文件直接关联`
    );
  }

  if (
    hasAny(text, ['法律尽职调查报告', '律师法律意见书', '投后合规检查', '整改报告'])
  ) {
    addContradiction(
      candidate,
      45,
      '文件包含法律尽调或投后整改特征，与投资合规性审查表存在冲突'
    );
  }

  return [candidate];
}

function directlyRelatedEvents(
  params: DecideWithProjectContextParams,
  eventTypes: string[]
) {
  return (
    params.projectContext?.timeline.filter(
      event =>
        eventTypes.includes(event.eventType) &&
        event.evidenceFiles.includes(params.sourcePath)
    ) ?? []
  );
}

function scoreShareholderResolution(
  params: DecideWithProjectContextParams
): MutableCandidate[] {
  const candidate = createCandidate(
    'investment-implementation',
    '股东会决议',
    20
  );
  const text = combinedFactsText(params.facts);

  if (hasAny(text, ['股东会决议', '股东决定'])) {
    addEvidence(candidate, 30, '文件正式标题或文档类型明确为目标公司股东会决议');
  }
  if (
    hasAny(text, [
      '本次增资',
      '注册资本由',
      '股权结构变更',
      '修改公司章程',
      '签署《增资协议》',
      '签署《股东协议》',
      '签署《加入协议》',
    ])
  ) {
    addEvidence(candidate, 30, '决议正文批准增资、交易文件或增资后公司治理变更');
  }
  for (const event of directlyRelatedEvents(params, [
    'shareholders_approved_transaction',
  ])) {
    addEvidence(candidate, 25, `项目事件“${event.title}”与当前股东会决议直接关联`);
  }
  if (hasAny(text, ['投资决策委员会', '投委会决议', '基金投委会'])) {
    addContradiction(candidate, 55, '文件具有基金投委会决议特征，不是目标公司股东会决议');
  }

  return [candidate];
}

function scoreClosingConfirmation(
  params: DecideWithProjectContextParams
): MutableCandidate[] {
  const candidate = createCandidate(
    'investment-implementation',
    '确权文件',
    20
  );
  const text = combinedFactsText(params.facts);

  if (hasAny(text, ['交割确认函', '交割证明书', '交割确认书'])) {
    addEvidence(candidate, 30, '文件正式标题或文档类型明确为交割确认文件');
  }
  if (
    hasAny(text, [
      '交割条件',
      '先决条件',
      '均已满足',
      '书面豁免',
      '截至交割日',
      '增资协议',
    ])
  ) {
    addEvidence(candidate, 25, '正文确认投资协议项下的交割条件或交割义务');
  }
  for (const event of directlyRelatedEvents(params, [
    'capital_increase_agreement_signed',
    'closing_conditions_confirmed',
  ])) {
    addEvidence(candidate, 20, `项目事件“${event.title}”与当前交割文件直接关联`);
  }
  if (
    hasAny(text, ['银行电子回单', '转账凭证']) ||
    (hasAny(text, ['缴款通知书']) && !hasAny(text, ['交割确认函']))
  ) {
    addContradiction(candidate, 45, '文件更像付款通知或付款凭证，不是交割确权文件');
  }
  if (hasAny(text, ['退出交易', '股权转让退出', '退出交割'])) {
    addContradiction(candidate, 55, '文件指向项目退出交割，不属于投资实施阶段');
  }

  return [candidate];
}

function scorePaymentNotice(
  params: DecideWithProjectContextParams
): MutableCandidate[] {
  const candidate = createCandidate(
    'investment-implementation',
    '付款通知函',
    20
  );
  const text = combinedFactsText(params.facts);

  if (hasAny(text, ['缴款通知书', '付款通知函', '付款通知书'])) {
    addEvidence(candidate, 30, '文件正式标题或文档类型明确为投资付款通知');
  }
  if (
    hasAny(text, ['支付增资款', '应支付的增资款', '电汇方式', '指定账户']) &&
    hasAny(text, ['增资协议', '加入协议', '交割条件', '本次增资'])
  ) {
    addEvidence(candidate, 30, '正文要求投资方依据交易文件支付投资款或增资款');
  }
  for (const event of directlyRelatedEvents(params, [
    'capital_increase_agreement_signed',
    'closing_conditions_confirmed',
  ])) {
    addEvidence(candidate, 20, `项目事件“${event.title}”与当前缴款通知直接关联`);
  }
  if (hasAny(text, ['银行电子回单', '交易成功', '转账凭证'])) {
    addContradiction(candidate, 50, '文件记录付款已完成，更像银行回单或转账凭证');
  }
  if (hasAny(text, ['退出交易', '股权转让退出', '退出价款'])) {
    addContradiction(candidate, 55, '文件指向项目退出付款，不属于投资实施阶段');
  }

  return [candidate];
}

function finalizeDecision(
  candidates: MutableCandidate[],
  facts: DocumentFacts
): ContextClassificationDecision {
  const normalized = candidates
    .map(candidate => ({
      ...candidate,
      score: clampScore(candidate.score),
    }))
    .sort((left, right) => right.score - left.score);
  const best = normalized[0];
  const runnerUp = normalized[1];
  const scoreGap = runnerUp ? best.score - runnerUp.score : best.score;
  const hasConflict = Boolean(
    runnerUp && best.score >= MIN_DECISION_SCORE && scoreGap < MIN_SCORE_GAP
  );
  const hasEnoughEvidence = best.score >= MIN_DECISION_SCORE;
  const policy = getCategoryEvidencePolicy(
    best.category.folderId,
    best.category.fileName
  );
  const extractionRisk =
    facts.extractionConfidence < 60 || facts.sourceQuality === 'filename_only';
  const requiresHumanReview =
    !hasEnoughEvidence ||
    hasConflict ||
    extractionRisk ||
    Boolean(policy?.defaultRequiresHumanReview);
  const status = !hasEnoughEvidence
    ? 'insufficient'
    : hasConflict
      ? 'conflict'
      : 'decided';
  const selectedCategory = status === 'decided' ? best.category : null;
  const evidence = best.evidence;
  const contradictions = best.contradictions;
  const reasoning =
    status === 'decided'
      ? `上下文证据支持归入“${best.category.folderPath.slice(1).join(' / ')} / ${best.category.fileName}”，得分 ${best.score}。`
      : status === 'conflict'
        ? `前两名候选仅相差 ${scoreGap} 分，项目证据存在冲突，不能自动决定。`
        : `最高候选仅 ${best.score} 分，缺少足够的项目级证据。`;

  return {
    status,
    selectedCategory,
    confidence: best.score,
    candidates: normalized,
    evidence,
    contradictions,
    requiresHumanReview,
    reasoning,
    policyVersion: policy
      ? `${POLICY_VERSION}+${policy.policyVersion}`
      : POLICY_VERSION,
  };
}

export function decideWithProjectContext(
  params: DecideWithProjectContextParams
): ContextClassificationDecision {
  if (params.facts.documentType === 'company_charter') {
    return finalizeDecision(scoreCompanyCharter(params), params.facts);
  }
  if (params.facts.documentType === 'investment_compliance_review') {
    return finalizeDecision(
      scoreInvestmentComplianceReview(params),
      params.facts
    );
  }
  if (params.facts.documentType === 'shareholder_resolution') {
    return finalizeDecision(scoreShareholderResolution(params), params.facts);
  }
  if (params.facts.documentType === 'closing_confirmation') {
    return finalizeDecision(scoreClosingConfirmation(params), params.facts);
  }
  if (params.facts.documentType === 'payment_notice') {
    return finalizeDecision(scorePaymentNotice(params), params.facts);
  }

  return {
    status: 'insufficient',
    selectedCategory: null,
    confidence: 0,
    candidates: [],
    evidence: [],
    contradictions: [
      `${POLICY_VERSION} 尚未配置文档类型 ${params.facts.documentType} 的上下文规则`,
    ],
    requiresHumanReview: true,
    reasoning: '当前文档类型尚无上下文决策规则，保留 legacy 分类结果。',
    policyVersion: POLICY_VERSION,
  };
}

export function parseProjectContextSnapshot(
  value: unknown
): ProjectContextSnapshot | null {
  const result = ProjectContextSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseRelatedDocumentFacts(
  value: unknown
): RelatedDocumentFacts[] {
  const result = z.array(RelatedDocumentFactsSchema).max(100).safeParse(value);
  return result.success ? result.data : [];
}
