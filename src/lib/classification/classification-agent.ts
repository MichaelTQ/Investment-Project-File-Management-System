import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import type { DocumentFacts, DocumentType } from './document-facts';
import {
  decideWithProjectContext,
  type ContextClassificationDecision,
  type ProjectContextSnapshot,
  type RelatedDocumentFacts,
} from './context-decision';

export type ClassificationAgentStatus =
  | 'running'
  | 'decided'
  | 'needs_review';

export interface ClassificationAgentTraceStep {
  node:
    | 'plan_evidence'
    | 'retrieve_related_document'
    | 'context_decision'
    | 'complete'
    | 'human_review';
  tool?: string;
  summary: string;
  round: number;
}

export interface ClassificationAgentInput {
  sourcePath: string;
  facts: DocumentFacts;
  projectContext?: ProjectContextSnapshot | null;
  availableRelatedDocuments?: RelatedDocumentFacts[];
  maxRounds?: number;
}

export interface ClassificationAgentResult {
  status: Exclude<ClassificationAgentStatus, 'running'>;
  decision: ContextClassificationDecision;
  selectedRelatedDocuments: RelatedDocumentFacts[];
  requestedEvidence: string[];
  trace: ClassificationAgentTraceStep[];
  rounds: number;
  llmCallCount: number;
  graphVersion: string;
}

const GRAPH_VERSION = 'classification-agent-langgraph-v1';

const AgentState = Annotation.Root({
  sourcePath: Annotation<string>(),
  facts: Annotation<DocumentFacts>(),
  projectContext: Annotation<ProjectContextSnapshot | null>(),
  availableRelatedDocuments: Annotation<RelatedDocumentFacts[]>(),
  selectedRelatedDocuments: Annotation<RelatedDocumentFacts[]>(),
  requestedEvidence: Annotation<string[]>(),
  decision: Annotation<ContextClassificationDecision | null>(),
  status: Annotation<ClassificationAgentStatus>(),
  rounds: Annotation<number>(),
  maxRounds: Annotation<number>(),
  llmCallCount: Annotation<number>(),
  trace: Annotation<ClassificationAgentTraceStep[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
});

type AgentGraphState = typeof AgentState.State;

function evidencePlanFor(documentType: DocumentType): string[] {
  if (documentType === 'company_charter') {
    return [
      'related_document:company_charter',
      'project_event:shareholders_approved_transaction',
    ];
  }
  if (documentType === 'investment_compliance_review') {
    return ['project_event:fund_compliance_review'];
  }
  return [`missing_context_policy:${documentType}`];
}

function remainingRelatedDocuments(
  state: AgentGraphState
): RelatedDocumentFacts[] {
  const selectedPaths = new Set(
    state.selectedRelatedDocuments.map(item => item.sourcePath)
  );
  if (state.facts.documentType !== 'company_charter') return [];
  return state.availableRelatedDocuments.filter(
    item =>
      item.sourcePath !== state.sourcePath &&
      item.facts.documentType === 'company_charter' &&
      !selectedPaths.has(item.sourcePath)
  );
}

const planEvidenceNode: typeof AgentState.Node = state => {
  const requestedEvidence = evidencePlanFor(state.facts.documentType);
  const remaining = remainingRelatedDocuments(state);
  return {
    requestedEvidence,
    trace: [
      {
        node: 'plan_evidence',
        tool: 'inspect_document_facts',
        summary:
          remaining.length > 0
            ? `文档类型为 ${state.facts.documentType}，发现 ${remaining.length} 份尚未比较的关联文件`
            : `文档类型为 ${state.facts.documentType}，当前没有可继续检索的关联文件`,
        round: state.rounds,
      },
    ],
  };
};

function routeAfterPlan(
  state: AgentGraphState
): 'retrieve_related_document' | 'context_decision' {
  return remainingRelatedDocuments(state).length > 0 &&
    state.rounds < state.maxRounds
    ? 'retrieve_related_document'
    : 'context_decision';
}

const retrieveRelatedDocumentNode: typeof AgentState.Node = state => {
  const nextDocument = remainingRelatedDocuments(state)[0];
  if (!nextDocument) {
    return {
      trace: [
        {
          node: 'retrieve_related_document',
          tool: 'retrieve_project_document_facts',
          summary: '没有找到满足当前证据计划的关联文件',
          round: state.rounds,
        },
      ],
    };
  }
  return {
    selectedRelatedDocuments: [
      ...state.selectedRelatedDocuments,
      nextDocument,
    ],
    rounds: state.rounds + 1,
    trace: [
      {
        node: 'retrieve_related_document',
        tool: 'retrieve_project_document_facts',
        summary: `选择关联文件“${nextDocument.sourcePath}”用于事实对比`,
        round: state.rounds + 1,
      },
    ],
  };
};

const contextDecisionNode: typeof AgentState.Node = state => {
  const decision = decideWithProjectContext({
    sourcePath: state.sourcePath,
    facts: state.facts,
    projectContext: state.projectContext,
    relatedDocuments: state.selectedRelatedDocuments,
  });
  return {
    decision,
    trace: [
      {
        node: 'context_decision',
        tool: 'decide_with_project_context',
        summary: `${decision.status}，最高得分 ${decision.confidence}，${decision.requiresHumanReview ? '需要人工复核' : '证据满足自动建议条件'}`,
        round: state.rounds,
      },
    ],
  };
};

function routeAfterDecision(
  state: AgentGraphState
): 'plan_evidence' | 'complete' | 'human_review' {
  if (
    state.decision?.status === 'decided' &&
    !state.decision.requiresHumanReview
  ) {
    return 'complete';
  }
  if (
    state.decision?.status !== 'decided' &&
    remainingRelatedDocuments(state).length > 0 &&
    state.rounds < state.maxRounds
  ) {
    return 'plan_evidence';
  }
  return 'human_review';
}

const completeNode: typeof AgentState.Node = state => ({
  status: 'decided',
  trace: [
    {
      node: 'complete',
      summary: `Agent以 ${state.decision?.policyVersion ?? 'unknown'} 完成上下文分类建议`,
      round: state.rounds,
    },
  ],
});

const humanReviewNode: typeof AgentState.Node = state => ({
  status: 'needs_review',
  trace: [
    {
      node: 'human_review',
      tool: 'request_human_review',
      summary:
        state.decision?.status === 'decided'
          ? '分类已有建议，但类别策略要求人工确认'
          : '证据不足、规则未覆盖或候选冲突，转人工复核',
      round: state.rounds,
    },
  ],
});

export const classificationAgentGraph = new StateGraph(AgentState)
  .addNode('plan_evidence', planEvidenceNode)
  .addNode('retrieve_related_document', retrieveRelatedDocumentNode)
  .addNode('context_decision', contextDecisionNode)
  .addNode('complete', completeNode)
  .addNode('human_review', humanReviewNode)
  .addEdge(START, 'plan_evidence')
  .addConditionalEdges('plan_evidence', routeAfterPlan, [
    'retrieve_related_document',
    'context_decision',
  ])
  .addEdge('retrieve_related_document', 'context_decision')
  .addConditionalEdges('context_decision', routeAfterDecision, [
    'plan_evidence',
    'complete',
    'human_review',
  ])
  .addEdge('complete', END)
  .addEdge('human_review', END)
  .compile();

export async function runClassificationAgent(
  input: ClassificationAgentInput
): Promise<ClassificationAgentResult> {
  const state = await classificationAgentGraph.invoke(
    {
      sourcePath: input.sourcePath,
      facts: input.facts,
      projectContext: input.projectContext ?? null,
      availableRelatedDocuments: input.availableRelatedDocuments ?? [],
      selectedRelatedDocuments: [],
      requestedEvidence: [],
      decision: null,
      status: 'running',
      rounds: 0,
      maxRounds: Math.max(1, Math.min(input.maxRounds ?? 3, 10)),
      llmCallCount: 0,
      trace: [],
    },
    { recursionLimit: 30 }
  );

  if (!state.decision || state.status === 'running') {
    throw new Error('分类Agent未能到达有效终止状态');
  }

  return {
    status: state.status,
    decision: state.decision,
    selectedRelatedDocuments: state.selectedRelatedDocuments,
    requestedEvidence: state.requestedEvidence,
    trace: state.trace,
    rounds: state.rounds,
    llmCallCount: state.llmCallCount,
    graphVersion: GRAPH_VERSION,
  };
}
