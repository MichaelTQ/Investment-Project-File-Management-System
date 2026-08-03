import type { DocumentFacts, DocumentType } from './document-facts';
import type { ProjectStage } from '../project-memory';

export type DecidedBusinessStage = Exclude<ProjectStage, 'unknown'>;

export interface BusinessStageCandidate {
  stage: DecidedBusinessStage;
  score: number;
  evidence: string[];
}

export interface BusinessStageDecision {
  status: 'decided' | 'insufficient' | 'conflict';
  selectedStage: DecidedBusinessStage | null;
  confidence: number;
  candidates: BusinessStageCandidate[];
  evidence: string[];
  reasoning: string;
}

interface TimelineEventLike {
  stage: ProjectStage;
  title: string;
  evidenceFiles: string[];
}

interface RelatedDocumentLike {
  sourcePath: string;
  facts: DocumentFacts;
}

export interface InferBusinessStageParams {
  sourcePath: string;
  facts?: DocumentFacts | null;
  text?: string;
  projectContext?: { timeline: TimelineEventLike[] } | null;
  relatedDocuments?: RelatedDocumentLike[];
}

const MIN_STAGE_SCORE = 50;
const MIN_STAGE_GAP = 15;

const STAGE_TERMS: Record<DecidedBusinessStage, Array<[string, number]>> = {
  pre_initiation: [
    ['立项前', 60],
    ['保密协议', 35],
    ['nda', 35],
  ],
  initiation: [
    ['项目立项', 60],
    ['立项会议', 50],
    ['立项会', 50],
    ['立项申请', 50],
    ['立项报告', 50],
    ['同意立项', 45],
    ['不同意立项', 45],
    ['通过立项', 45],
    ['立项表决', 45],
    ['立项', 25],
  ],
  due_diligence: [
    ['尽职调查', 60],
    ['尽调报告', 50],
    ['业务尽调', 45],
    ['财务尽调', 45],
    ['法律尽调', 45],
  ],
  investment_decision: [
    ['投资决策委员会', 60],
    ['投委会决议', 55],
    ['投资决策', 50],
    ['上会申请', 45],
    ['同意投资', 45],
  ],
  investment_execution: [
    ['投资实施', 60],
    ['增资协议', 45],
    ['交割确认', 45],
    ['缴款通知', 45],
    ['工商变更', 40],
  ],
  post_investment: [
    ['投后管理', 60],
    ['投后报告', 50],
    ['投后风险', 45],
    ['实地调研', 40],
  ],
  exit_decision: [
    ['退出决策', 60],
    ['退出投委会', 55],
    ['退出表决', 50],
    ['退出方案', 45],
  ],
  exit_execution: [
    ['退出执行', 60],
    ['退出交割', 50],
    ['退出价款', 45],
    ['档案移交', 40],
  ],
};

// 只有在当前目录体系中不存在跨阶段歧义的文档类型，才提供阶段先验。
const DOCUMENT_TYPE_STAGE_HINTS: Partial<
  Record<DocumentType, DecidedBusinessStage>
> = {
  confidentiality_agreement: 'pre_initiation',
  project_initiation_application: 'initiation',
  project_initiation_report: 'initiation',
  business_plan: 'initiation',
  due_diligence_report: 'due_diligence',
  investment_recommendation: 'investment_decision',
  investment_compliance_review: 'investment_decision',
  capital_increase_agreement: 'investment_execution',
  shareholder_agreement: 'investment_execution',
  closing_confirmation: 'investment_execution',
  payment_notice: 'investment_execution',
};

function factsText(facts: DocumentFacts | null | undefined): string {
  if (!facts) return '';
  return [
    facts.title,
    facts.rawDocumentType,
    ...facts.explicitStageClues,
    ...facts.evidenceQuotes,
    ...facts.transactionChanges.map(change => change.evidence),
  ].join('\n');
}

function collectTextScores(
  value: string,
  multiplier = 1
): Map<DecidedBusinessStage, BusinessStageCandidate> {
  const normalized = value.normalize('NFKC').toLowerCase();
  const scores = new Map<DecidedBusinessStage, BusinessStageCandidate>();
  for (const [stage, terms] of Object.entries(STAGE_TERMS) as Array<
    [DecidedBusinessStage, Array<[string, number]>]
  >) {
    for (const [term, weight] of terms) {
      if (!normalized.includes(term)) continue;
      const candidate = scores.get(stage) ?? { stage, score: 0, evidence: [] };
      candidate.score += Math.round(weight * multiplier);
      const evidence = `明确出现“${term}”`;
      if (!candidate.evidence.includes(evidence)) candidate.evidence.push(evidence);
      scores.set(stage, candidate);
    }
  }
  return scores;
}

function mergeCandidate(
  target: Map<DecidedBusinessStage, BusinessStageCandidate>,
  candidate: BusinessStageCandidate,
  maxAddedScore?: number
): void {
  const current = target.get(candidate.stage) ?? {
    stage: candidate.stage,
    score: 0,
    evidence: [],
  };
  current.score += Math.min(candidate.score, maxAddedScore ?? candidate.score);
  for (const evidence of candidate.evidence) {
    if (!current.evidence.includes(evidence)) current.evidence.push(evidence);
  }
  target.set(candidate.stage, current);
}

export function inferBusinessStage(
  params: InferBusinessStageParams
): BusinessStageDecision {
  const scores = new Map<DecidedBusinessStage, BusinessStageCandidate>();
  const currentText = [params.sourcePath, params.text ?? '', factsText(params.facts)].join('\n');
  for (const candidate of collectTextScores(currentText).values()) {
    mergeCandidate(scores, candidate);
  }

  const typeHint = params.facts
    ? DOCUMENT_TYPE_STAGE_HINTS[params.facts.documentType]
    : undefined;
  if (typeHint) {
    mergeCandidate(scores, {
      stage: typeHint,
      score: 55,
      evidence: [`文档类型 ${params.facts?.documentType} 在当前目录规范中仅对应此阶段`],
    });
  }

  for (const event of params.projectContext?.timeline ?? []) {
    if (event.stage === 'unknown' || !event.evidenceFiles.includes(params.sourcePath)) {
      continue;
    }
    mergeCandidate(scores, {
      stage: event.stage,
      score: 70,
      evidence: [`项目事件“${event.title}”直接引用当前文件`],
    });
  }

  for (const related of params.relatedDocuments ?? []) {
    const relatedScores = Array.from(
      collectTextScores([related.sourcePath, factsText(related.facts)].join('\n')).values()
    ).sort((left, right) => right.score - left.score);
    const bestRelated = relatedScores[0];
    const runnerUpRelated = relatedScores[1];
    if (
      bestRelated &&
      bestRelated.score >= MIN_STAGE_SCORE &&
      (!runnerUpRelated || bestRelated.score - runnerUpRelated.score >= MIN_STAGE_GAP)
    ) {
      mergeCandidate(
        scores,
        {
          stage: bestRelated.stage,
          score: 20,
          evidence: [`关联文件“${related.sourcePath}”提供同阶段线索`],
        },
        20
      );
    }
  }

  const candidates = Array.from(scores.values())
    .map(candidate => ({ ...candidate, score: Math.min(100, candidate.score) }))
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  const runnerUp = candidates[1];
  const gap = runnerUp ? best.score - runnerUp.score : best?.score ?? 0;
  const enough = Boolean(best && best.score >= MIN_STAGE_SCORE);
  const conflict = Boolean(enough && runnerUp && gap < MIN_STAGE_GAP);
  const status = !enough ? 'insufficient' : conflict ? 'conflict' : 'decided';
  const selectedStage = status === 'decided' ? best.stage : null;

  return {
    status,
    selectedStage,
    confidence: best?.score ?? 0,
    candidates,
    evidence: best?.evidence ?? [],
    reasoning:
      status === 'decided'
        ? `文件证据支持业务阶段 ${best.stage}，阶段得分 ${best.score}。`
        : status === 'conflict'
          ? `业务阶段候选仅相差 ${gap} 分，不能锁定归档阶段。`
          : `最高业务阶段得分仅 ${best?.score ?? 0}，需要人工确认阶段。`,
  };
}
