import {
  runClassificationAgent,
  type ClassificationAgentResult,
} from './classification-agent';
import type {
  ProjectContextSnapshot,
  RelatedDocumentFacts,
} from './context-decision';
import {
  clearDurableProjectMemory,
  compactLegacyProjectMemory,
  loadDurableProjectMemory,
  loadDurableProjectRevision,
  saveDurableProjectMemorySnapshot,
  type ProjectContextLifecycleState,
  type RebuildHistoryEntry,
  MAX_REBUILD_HISTORY,
} from './durable-project-memory';
import type { DocumentFacts, DocumentType } from './document-facts';
import {
  synthesizeProjectContext,
  type ProjectContextSynthesisResult,
  type SynthesizeProjectContextParams,
} from './project-context-synthesizer';

const DURABLE_MEMORY_MODE = 's3-durable-shadow' as const;
const FALLBACK_MEMORY_MODE = 'process-local-fallback' as const;
const PROJECT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PROJECTS = 50;
const MAX_DOCUMENTS_PER_PROJECT = 200;

interface SessionDocumentRecord {
  sourcePath: string;
  archivedFileId?: string;
  facts: DocumentFacts;
  agentDecision: ClassificationAgentResult | null;
  firstSeenAt: number;
  updatedAt: number;
}

interface SessionProjectRecord {
  projectId: string;
  revision: number;
  context: ProjectContextSnapshot | null;
  contextState: ProjectContextLifecycleState;
  documents: Map<string, SessionDocumentRecord>;
  rebuildHistory: RebuildHistoryEntry[];
  updatedAt: number;
}

interface SessionMemoryStore {
  projects: Map<string, SessionProjectRecord>;
  projectLocks: Map<string, Promise<void>>;
}

type RuntimeWithSessionMemory = typeof globalThis & {
  __classificationSessionMemory?: SessionMemoryStore;
};

export interface ReEvaluatedDocument {
  sourcePath: string;
  previousStatus: ClassificationAgentResult['status'];
  status: ClassificationAgentResult['status'];
  previousFolder: string | null;
  selectedFolder: string | null;
  agentDecision: ClassificationAgentResult;
}

export interface ProjectMemoryDocumentView {
  sourcePath: string;
  documentType: DocumentFacts['documentType'];
  title: string;
  sourceQuality: DocumentFacts['sourceQuality'];
  extractionConfidence: number;
  factStatus: 'extracted' | 'repaired' | 'fallback' | 'type_recovered';
  warnings: string[];
  agentStatus: ClassificationAgentResult['status'] | null;
  selectedFolder: string | null;
}

export interface ProjectSessionMemoryView {
  mode: typeof DURABLE_MEMORY_MODE | typeof FALLBACK_MEMORY_MODE;
  persistent: boolean;
  persistenceWarning?: string;
  memoryLoadDurationMs: number;
  projectId: string;
  revision: number;
  documentCount: number;
  relatedDocumentCount: number;
  documents: ProjectMemoryDocumentView[];
  projectContext: ProjectContextSnapshot | null;
  contextState: ProjectContextLifecycleState;
  decisionContextVersion?: number;
  contextSynthesis?: {
    status: ProjectContextSynthesisResult['status'];
    llmCallCount: number;
    modelCalls: ProjectContextSynthesisResult['modelCalls'];
    totalDurationMs: number;
    inputDocumentCount: number;
    includedDocumentCount: number;
    latestEvidencedStage: ProjectContextSnapshot['latestEvidencedStage'];
    stageConfidence: ProjectContextSnapshot['stageConfidence'];
    eventCount: number;
    relationCount: number;
    conflictCount: number;
    error?: string;
  };
  reEvaluatedDocuments: ReEvaluatedDocument[];
  rebuildHistory: RebuildHistoryEntry[];
  expiresAt?: string;
}

export interface RememberAndEvaluateResult extends ProjectSessionMemoryView {
  currentDecision: ClassificationAgentResult;
}

export interface RememberAndEvaluateParams {
  projectId: string;
  projectName?: string;
  sourcePath: string;
  facts: DocumentFacts;
  projectContext?: ProjectContextSnapshot | null;
  suppliedRelatedDocuments?: RelatedDocumentFacts[];
  customHeaders?: Record<string, string>;
  contextSynthesizerClient?: SynthesizeProjectContextParams['client'];
}

export interface CommitArchivedProjectDocumentParams
  extends RememberAndEvaluateParams {
  archivedFileId?: string;
  deferContextRebuild?: boolean;
}

export interface ProjectMemoryMutationContext {
  projectName?: string;
  customHeaders?: Record<string, string>;
  contextSynthesizerClient?: SynthesizeProjectContextParams['client'];
}

function memoryStore(): SessionMemoryStore {
  const runtime = globalThis as RuntimeWithSessionMemory;
  runtime.__classificationSessionMemory ??= {
    projects: new Map(),
    projectLocks: new Map(),
  };
  return runtime.__classificationSessionMemory;
}

function normalizeSourcePath(sourcePath: string): string {
  return sourcePath.trim().replaceAll('\\', '/').replace(/^\/+/, '');
}

function selectedFolderName(
  decision: ClassificationAgentResult | null
): string | null {
  return decision?.decision.selectedFolder?.name ?? null;
}

function decisionSignature(decision: ClassificationAgentResult | null): string {
  return JSON.stringify({
    status: decision?.status ?? null,
    decisionStatus: decision?.decision.status ?? null,
    folderId: decision?.decision.selectedFolder?.folderId ?? null,
    requiresHumanReview: decision?.decision.requiresHumanReview ?? true,
  });
}

function recoverDocumentType(
  sourcePath: string,
  facts: DocumentFacts
): DocumentFacts {
  if (!['unknown', 'other'].includes(facts.documentType)) return facts;
  const identity = [sourcePath, facts.title, facts.rawDocumentType].join('\n');
  const rules: Array<{
    terms: string[];
    documentType: DocumentType;
    label: string;
  }> = [
    { terms: ['公司章程'], documentType: 'company_charter', label: '公司章程' },
    { terms: ['股东会决议'], documentType: 'shareholder_resolution', label: '股东会决议' },
    { terms: ['增资协议'], documentType: 'capital_increase_agreement', label: '增资协议' },
    { terms: ['交割确认函', '交割确认书'], documentType: 'closing_confirmation', label: '交割确认文件' },
    { terms: ['缴款通知书', '付款通知函'], documentType: 'payment_notice', label: '缴款通知文件' },
    { terms: ['尽职调查报告', '尽调报告'], documentType: 'due_diligence_report', label: '尽职调查报告' },
    { terms: ['投资合规性审查表', '合规性审查表'], documentType: 'investment_compliance_review', label: '投资合规性审查表' },
  ];
  const matched = rules.find(rule =>
    rule.terms.some(term => identity.includes(term))
  );
  if (!matched) return facts;
  const warning = `文档类型由明确文件名或标题“${matched.label}”保守恢复`;
  return {
    ...facts,
    documentType: matched.documentType,
    warnings: facts.warnings.includes(warning)
      ? facts.warnings
      : [...facts.warnings, warning],
  };
}

function projectDocumentViews(
  project: SessionProjectRecord
): ProjectMemoryDocumentView[] {
  return [...project.documents.values()]
    .sort((left, right) => left.firstSeenAt - right.firstSeenAt)
    .map(document => ({
      sourcePath: document.sourcePath,
      documentType: document.facts.documentType,
      title: document.facts.title,
      sourceQuality: document.facts.sourceQuality,
      extractionConfidence: document.facts.extractionConfidence,
      factStatus: document.facts.warnings.some(warning =>
        warning.includes('保守恢复')
      )
        ? 'type_recovered'
        : document.facts.warnings.some(warning =>
              warning.includes('结构化事实抽取失败')
            )
          ? 'fallback'
          : document.facts.warnings.some(warning =>
                warning.includes('结构化输出已校正')
              )
            ? 'repaired'
            : document.facts.extractionConfidence === 0
              ? 'fallback'
          : 'extracted',
      warnings: document.facts.warnings,
      agentStatus: document.agentDecision?.status ?? null,
      selectedFolder: selectedFolderName(document.agentDecision),
    }));
}

function pruneFallbackProjects(store: SessionMemoryStore, now: number): void {
  for (const [projectId, project] of store.projects) {
    if (now - project.updatedAt > PROJECT_TTL_MS) {
      store.projects.delete(projectId);
    }
  }
  if (store.projects.size <= MAX_PROJECTS) return;
  const oldest = [...store.projects.values()].sort(
    (left, right) => left.updatedAt - right.updatedAt
  );
  for (const project of oldest.slice(0, store.projects.size - MAX_PROJECTS)) {
    store.projects.delete(project.projectId);
  }
}

function trimFallbackDocuments(
  project: SessionProjectRecord,
  protectedPath: string
): void {
  if (project.documents.size <= MAX_DOCUMENTS_PER_PROJECT) return;
  const oldest = [...project.documents.values()]
    .filter(document => document.sourcePath !== protectedPath)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  for (const document of oldest.slice(
    0,
    project.documents.size - MAX_DOCUMENTS_PER_PROJECT
  )) {
    project.documents.delete(document.sourcePath);
  }
}

async function withProjectLock<T>(
  projectId: string,
  action: () => Promise<T>
): Promise<T> {
  const store = memoryStore();
  const previous = store.projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  store.projectLocks.set(projectId, queued);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (store.projectLocks.get(projectId) === queued) {
      store.projectLocks.delete(projectId);
    }
  }
}

function mergeProjects(
  durable: SessionProjectRecord,
  local: SessionProjectRecord | undefined
): SessionProjectRecord {
  if (!local) return durable;
  for (const [sourcePath, document] of local.documents) {
    const persisted = durable.documents.get(sourcePath);
    if (!persisted || document.updatedAt > persisted.updatedAt) {
      durable.documents.set(sourcePath, document);
    }
  }
  if (!durable.context && local.context) durable.context = local.context;
  if (local.contextState.version > durable.contextState.version) {
    durable.contextState = local.contextState;
    durable.context = local.context;
  }
  durable.revision = Math.max(durable.revision, local.revision);
  durable.updatedAt = Math.max(durable.updatedAt, local.updatedAt);
  // 合并重建历史：以 durable 为主，补充 local 中更新的条目
  const durableHistory = durable.rebuildHistory ?? [];
  const localHistory = local.rebuildHistory ?? [];
  if (localHistory.length > 0) {
    const durableTimestamps = new Set(durableHistory.map(e => e.timestamp));
    const newEntries = localHistory.filter(e => !durableTimestamps.has(e.timestamp));
    if (newEntries.length > 0) {
      durable.rebuildHistory = [...durableHistory, ...newEntries]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_REBUILD_HISTORY);
    } else {
      durable.rebuildHistory = durableHistory;
    }
  } else if (!durable.rebuildHistory) {
    durable.rebuildHistory = durableHistory;
  }
  return durable;
}

function initialContextState(): ProjectContextLifecycleState {
  return {
    status: 'clean',
    version: 0,
    basedOnRevision: 0,
    dirtyReasons: [],
    updatedAt: null,
    lastAttemptAt: null,
  };
}

function recordPendingChange(
  project: SessionProjectRecord,
  kind: 'added' | 'deleted' | 'moved',
  sourcePath: string
): void {
  const existing = project.contextState.pendingChanges ?? {
    fromRevision: project.contextState.basedOnRevision + 1,
    toRevision: project.revision,
    added: [],
    deleted: [],
    moved: [],
  };
  const next = {
    ...existing,
    toRevision: project.revision,
    added: [...existing.added],
    deleted: [...existing.deleted],
    moved: [...existing.moved],
  };
  if (kind === 'added') {
    next.deleted = next.deleted.filter(path => path !== sourcePath);
  } else if (kind === 'deleted') {
    next.added = next.added.filter(path => path !== sourcePath);
    next.moved = next.moved.filter(path => path !== sourcePath);
  }
  if (!next[kind].includes(sourcePath)) next[kind].push(sourcePath);
  project.contextState.pendingChanges = next;
}

function combinedRelatedDocuments(
  project: SessionProjectRecord,
  supplied: RelatedDocumentFacts[]
): RelatedDocumentFacts[] {
  const byPath = new Map<string, RelatedDocumentFacts>();
  for (const document of supplied) {
    const sourcePath = normalizeSourcePath(document.sourcePath);
    if (sourcePath) byPath.set(sourcePath, { ...document, sourcePath });
  }
  for (const document of project.documents.values()) {
    byPath.set(document.sourcePath, {
      sourcePath: document.sourcePath,
      facts: document.facts,
    });
  }
  return [...byPath.values()];
}

function fallbackProject(
  projectId: string,
  existing: SessionProjectRecord | undefined,
  now: number
): SessionProjectRecord {
  return (
    existing ?? {
      projectId,
      revision: 0,
      context: null,
      contextState: initialContextState(),
      documents: new Map(),
      rebuildHistory: [],
      updatedAt: now,
    }
  );
}

interface LoadedProject {
  project: SessionProjectRecord;
  mode: ProjectSessionMemoryView['mode'];
  persistenceWarning?: string;
  loadDurationMs: number;
  needsLegacyCompaction: boolean;
}

async function loadProjectRecord(projectId: string): Promise<LoadedProject> {
  const loadStartedAt = Date.now();
  const store = memoryStore();
  const now = Date.now();
  pruneFallbackProjects(store, now);
  try {
    const local = store.projects.get(projectId);
    if (local) {
      const durableRevision = await loadDurableProjectRevision(projectId);
      if (durableRevision !== null && durableRevision === local.revision) {
        return {
          project: local,
          mode: DURABLE_MEMORY_MODE,
          loadDurationMs: Date.now() - loadStartedAt,
          needsLegacyCompaction: false,
        };
      }
    }
    const durable = await loadDurableProjectMemory(projectId);
    const project = mergeProjects(
      {
        projectId,
        revision: durable.revision,
        context: durable.context,
        contextState: durable.contextState,
        documents: durable.documents,
        rebuildHistory: durable.rebuildHistory ?? [],
        updatedAt: Math.max(
          now,
          ...[...durable.documents.values()].map(document => document.updatedAt)
        ),
      },
      local && local.revision >= durable.revision ? local : undefined
    );
    for (const document of project.documents.values()) {
      document.facts = recoverDocumentType(document.sourcePath, document.facts);
    }
    store.projects.set(projectId, project);
    return {
      project,
      mode: DURABLE_MEMORY_MODE,
      loadDurationMs: Date.now() - loadStartedAt,
      needsLegacyCompaction: durable.loadedFrom === 'legacy',
    };
  } catch (error) {
    console.error('Durable project memory load failed:', error);
    return {
      project: fallbackProject(projectId, store.projects.get(projectId), now),
      mode: FALLBACK_MEMORY_MODE,
      persistenceWarning:
        error instanceof Error ? error.message : 'S3 项目记忆暂时不可用',
      loadDurationMs: Date.now() - loadStartedAt,
      needsLegacyCompaction: false,
    };
  }
}

async function persistProjectSnapshot(loaded: LoadedProject): Promise<void> {
  if (loaded.mode !== DURABLE_MEMORY_MODE) return;
  const { project } = loaded;
  try {
    await saveDurableProjectMemorySnapshot({
      projectId: project.projectId,
      revision: project.revision,
      context: project.context,
      contextState: project.contextState,
      documents: project.documents,
      rebuildHistory: project.rebuildHistory,
      updatedAt: project.updatedAt,
    });
    if (loaded.needsLegacyCompaction) {
      await compactLegacyProjectMemory(project.projectId);
      loaded.needsLegacyCompaction = false;
    }
  } catch (error) {
    loaded.mode = FALLBACK_MEMORY_MODE;
    loaded.persistenceWarning =
      error instanceof Error ? error.message : 'S3 项目记忆快照写入失败';
  }
}

function synthesisView(result: ProjectContextSynthesisResult) {
  return {
    status: result.status,
    llmCallCount: result.llmCallCount,
    modelCalls: result.modelCalls,
    totalDurationMs: result.totalDurationMs,
    inputDocumentCount: result.inputDocumentCount,
    includedDocumentCount: result.includedDocumentCount,
    latestEvidencedStage: result.context.latestEvidencedStage,
    stageConfidence: result.context.stageConfidence,
    eventCount: result.context.timeline.length,
    relationCount: result.context.documentRelations?.length ?? 0,
    conflictCount: result.context.conflicts?.length ?? 0,
    error: result.error,
  };
}

function memoryView(params: {
  loaded: LoadedProject;
  relatedDocumentCount?: number;
  reEvaluatedDocuments?: ReEvaluatedDocument[];
  synthesis?: ProjectContextSynthesisResult;
  decisionContextVersion?: number;
}): ProjectSessionMemoryView {
  const { project, mode, persistenceWarning } = params.loaded;
  return {
    mode,
    persistent: mode === DURABLE_MEMORY_MODE,
    persistenceWarning,
    memoryLoadDurationMs: params.loaded.loadDurationMs,
    projectId: project.projectId,
    revision: project.revision,
    documentCount: project.documents.size,
    relatedDocumentCount:
      params.relatedDocumentCount ?? Math.max(0, project.documents.size - 1),
    documents: projectDocumentViews(project),
    projectContext: project.context,
    contextState: project.contextState,
    decisionContextVersion: params.decisionContextVersion,
    contextSynthesis: params.synthesis
      ? synthesisView(params.synthesis)
      : undefined,
    reEvaluatedDocuments: params.reEvaluatedDocuments ?? [],
    rebuildHistory: project.rebuildHistory,
    expiresAt:
      mode === FALLBACK_MEMORY_MODE
        ? new Date(project.updatedAt + PROJECT_TTL_MS).toISOString()
        : undefined,
  };
}

type ReevaluationMode = 'incremental' | 'full';
type RebuildTrigger = 'add_file' | 'delete_file' | 'manual';

async function rebuildLoadedProject(
  loaded: LoadedProject,
  options: ProjectMemoryMutationContext = {},
  skipPersistSourcePath?: string,
  reevaluationMode: ReevaluationMode = 'full',
  trigger: RebuildTrigger = 'manual'
): Promise<{
  synthesis: ProjectContextSynthesisResult;
  reEvaluatedDocuments: ReEvaluatedDocument[];
}> {
  const rebuildStartAt = Date.now();
  const { project } = loaded;
  const previousStage = project.context?.latestEvidencedStage ?? 'unknown';
  const pendingChanges = project.contextState.pendingChanges;
  // 如果本轮变更包含删除文件，影响面较大，自动升级为全量重评估。
  const effectiveReevaluationMode: ReevaluationMode =
    reevaluationMode === 'incremental' &&
    pendingChanges &&
    pendingChanges.deleted.length > 0
      ? 'full'
      : reevaluationMode;
  const now = Math.max(
    Date.now(),
    (project.contextState.updatedAt ?? project.contextState.lastAttemptAt ?? 0) + 1
  );
  project.contextState = {
    ...project.contextState,
    status: 'rebuilding',
    lastAttemptAt: now,
    lastError: undefined,
  };
  const documents = combinedRelatedDocuments(project, []);
  const synthesisStartAt = Date.now();
  const synthesis = await synthesizeProjectContext({
    projectName:
      options.projectName?.trim() ||
      project.context?.projectName ||
      project.projectId,
    documents,
    previousContext: project.context,
    customHeaders: options.customHeaders,
    client: options.contextSynthesizerClient,
    allowLlm: Boolean(options.contextSynthesizerClient || options.customHeaders),
    focusSourcePaths: pendingChanges
      ? [...pendingChanges.added, ...pendingChanges.moved]
      : undefined,
    removedSourcePaths: pendingChanges?.deleted,
  });
  const synthesisDurationMs = Date.now() - synthesisStartAt;
  const synthesisSucceeded = !synthesis.error;
  if (synthesisSucceeded || !project.context) {
    project.context = synthesis.context;
  }
  project.contextState = synthesisSucceeded
    ? {
        status: 'clean',
        version: project.contextState.version + 1,
        basedOnRevision: project.revision,
        dirtyReasons: [],
        updatedAt: now,
        lastAttemptAt: now,
        pendingChanges: undefined,
      }
    : {
        ...project.contextState,
        status: 'failed',
        dirtyReasons:
          project.contextState.dirtyReasons.length > 0
            ? project.contextState.dirtyReasons
            : ['项目Context重建失败，仍使用上一版Context'],
        lastAttemptAt: now,
        lastError: synthesis.error,
      };
  project.updatedAt = now;

  const reEvaluatedDocuments: ReEvaluatedDocument[] = [];
  const availableDocuments = combinedRelatedDocuments(project, []);

  // 增量模式：只重评估受新 Context 影响的文档；
  // 全量模式（删除/手动重建）：重评估所有文档。
  const documentsToReevaluate = (() => {
    if (effectiveReevaluationMode === 'full') return [...project.documents.values()];

    // 增量模式：从新 Context 中提取被引用的 sourcePath
    const contextReferencedPaths = new Set<string>();
    for (const event of project.context?.timeline ?? []) {
      for (const path of event.evidenceFiles) {
        contextReferencedPaths.add(normalizeSourcePath(path));
      }
    }
    for (const relation of project.context?.documentRelations ?? []) {
      contextReferencedPaths.add(normalizeSourcePath(relation.fromSourcePath));
      contextReferencedPaths.add(normalizeSourcePath(relation.toSourcePath));
    }
    for (const hypothesis of project.context?.stageHypotheses ?? []) {
      for (const path of hypothesis.evidenceFiles) {
        contextReferencedPaths.add(normalizeSourcePath(path));
      }
    }
    for (const conflict of project.context?.conflicts ?? []) {
      for (const path of conflict.evidenceFiles) {
        contextReferencedPaths.add(normalizeSourcePath(path));
      }
    }

    // 本轮新增/移动的文件
    const changedPaths = new Set<string>([
      ...(pendingChanges?.added ?? []).map(normalizeSourcePath),
      ...(pendingChanges?.moved ?? []).map(normalizeSourcePath),
    ]);

    // 筛选受影响的文档：被新 Context 引用、本轮变更、或与新 Context
    // 中被引用文件同 documentType / 同当事方的文档
    const referencedTypes = new Set<string>();
    const referencedParties = new Set<string>();
    for (const record of project.documents.values()) {
      if (
        contextReferencedPaths.has(record.sourcePath) ||
        changedPaths.has(record.sourcePath)
      ) {
        referencedTypes.add(record.facts.documentType);
        for (const party of record.facts.parties) {
          referencedParties.add(party.name);
        }
      }
    }

    return [...project.documents.values()].filter(record => {
      // 被 Context 直接引用 → 重评估
      if (contextReferencedPaths.has(record.sourcePath)) return true;
      // 本轮变更的文件 → 重评估
      if (changedPaths.has(record.sourcePath)) return true;
      // 同文档类型 → 可能需要改判（如新旧章程）
      if (referencedTypes.has(record.facts.documentType)) return true;
      // 同当事方 → 可能受交易关系影响
      if (record.facts.parties.some(party => referencedParties.has(party.name))) {
        return true;
      }
      return false;
    });
  })();

  const reevaluationStartAt = Date.now();
  for (const record of documentsToReevaluate) {
    const previousDecision = record.agentDecision;
    const decision = await runClassificationAgent({
      sourcePath: record.sourcePath,
      facts: record.facts,
      projectContext: project.context,
      availableRelatedDocuments: availableDocuments.filter(
        document => document.sourcePath !== record.sourcePath
      ),
    });
    record.agentDecision = decision;
    if (decisionSignature(previousDecision) !== decisionSignature(decision)) {
      record.updatedAt = Math.max(now, record.updatedAt + 1);
      if (previousDecision) {
        reEvaluatedDocuments.push({
          sourcePath: record.sourcePath,
          previousStatus: previousDecision.status,
          status: decision.status,
          previousFolder: selectedFolderName(previousDecision),
          selectedFolder: selectedFolderName(decision),
          agentDecision: decision,
        });
      }
    }
  }
  const reevaluationDurationMs = Date.now() - reevaluationStartAt;
  memoryStore().projects.set(project.projectId, project);
  void skipPersistSourcePath;
  await persistProjectSnapshot(loaded);

  // 记录重建历史
  const totalDurationMs = Date.now() - rebuildStartAt;
  const inputTokens = synthesis.modelCalls.reduce(
    (sum, call) => sum + (call.estimatedInputTokens ?? 0),
    0
  );
  const outputTokens = synthesis.modelCalls.reduce(
    (sum, call) => sum + (call.outputTokens ?? 0),
    0
  );
  const newStage = project.context?.latestEvidencedStage ?? 'unknown';
  const historyEntry: RebuildHistoryEntry = {
    trigger,
    timestamp: rebuildStartAt,
    totalDurationMs,
    synthesisDurationMs,
    reevaluationDurationMs,
    llmCallCount: synthesis.llmCallCount,
    inputTokens,
    outputTokens,
    inputDocumentCount: synthesis.inputDocumentCount,
    includedDocumentCount: synthesis.includedDocumentCount,
    reevaluationMode: effectiveReevaluationMode,
    totalDocumentCount: project.documents.size,
    reEvaluatedDocumentCount: documentsToReevaluate.length,
    changedDecisionCount: reEvaluatedDocuments.length,
    status: synthesisSucceeded ? 'success' : 'failed',
    contextVersion: project.contextState.version,
    contextStatus: synthesis.status,
    error: synthesis.error,
  };
  if (previousStage !== newStage) {
    historyEntry.stageTransition = { from: previousStage, to: newStage };
  }
  project.rebuildHistory = [historyEntry, ...(project.rebuildHistory ?? [])].slice(
    0,
    MAX_REBUILD_HISTORY
  );
  memoryStore().projects.set(project.projectId, project);
  await persistProjectSnapshot(loaded);

  return { synthesis, reEvaluatedDocuments };
}

export async function evaluateProjectDocumentCandidate(
  params: RememberAndEvaluateParams
): Promise<RememberAndEvaluateResult> {
  const projectId = params.projectId.trim();
  const sourcePath = normalizeSourcePath(params.sourcePath);
  if (!projectId) throw new Error('项目记忆需要有效的 projectId');
  if (!sourcePath) throw new Error('项目记忆需要有效的 sourcePath');

  return withProjectLock(projectId, async () => {
    const loaded = await loadProjectRecord(projectId);
    const { project } = loaded;
    let rebuildResult:
      | Awaited<ReturnType<typeof rebuildLoadedProject>>
      | undefined;
    if (
      project.contextState.status === 'dirty' ||
      project.contextState.status === 'failed' ||
      (!project.context && project.documents.size > 0)
    ) {
      rebuildResult = await rebuildLoadedProject(loaded, params, undefined, 'incremental', 'add_file');
    }
    const currentFacts = recoverDocumentType(sourcePath, params.facts);
    const availableDocuments = combinedRelatedDocuments(
      project,
      params.suppliedRelatedDocuments ?? []
    ).filter(document => document.sourcePath !== sourcePath);
    const decisionContext = params.projectContext ?? project.context;
    const currentDecision = await runClassificationAgent({
      sourcePath,
      facts: currentFacts,
      projectContext: decisionContext,
      availableRelatedDocuments: availableDocuments,
    });
    return {
      ...memoryView({
        loaded,
        relatedDocumentCount: availableDocuments.length,
        reEvaluatedDocuments: rebuildResult?.reEvaluatedDocuments,
        synthesis: rebuildResult?.synthesis,
        decisionContextVersion: project.contextState.version,
      }),
      currentDecision,
    };
  });
}

export async function commitArchivedProjectDocument(
  params: CommitArchivedProjectDocumentParams
): Promise<RememberAndEvaluateResult> {
  const projectId = params.projectId.trim();
  const sourcePath = normalizeSourcePath(params.sourcePath);
  if (!projectId || !sourcePath) throw new Error('提交项目事实缺少项目或源路径');
  return withProjectLock(projectId, async () => {
    const loaded = await loadProjectRecord(projectId);
    const { project } = loaded;
    const now = Date.now();
    const existing = project.documents.get(sourcePath);
    const currentRecord: SessionDocumentRecord = {
      sourcePath,
      archivedFileId: params.archivedFileId,
      facts: recoverDocumentType(sourcePath, params.facts),
      agentDecision: existing?.agentDecision ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
    };
    project.documents.set(sourcePath, currentRecord);
    project.revision += 1;
    recordPendingChange(project, 'added', sourcePath);
    project.updatedAt = now;
    if (loaded.mode === FALLBACK_MEMORY_MODE) {
      trimFallbackDocuments(project, sourcePath);
    }
    memoryStore().projects.set(projectId, project);

    // 先把正式文件事实写入最新快照，再生成依赖该事实的下一版 Context。
    project.contextState = {
      ...project.contextState,
      status: 'dirty',
      dirtyReasons: [
        ...new Set([
          ...project.contextState.dirtyReasons,
          `已归档文件“${sourcePath}”，Context 待更新`,
        ]),
      ],
    };

    if (params.deferContextRebuild) {
      const availableDocuments = combinedRelatedDocuments(project, []).filter(
        document => document.sourcePath !== sourcePath
      );
      const currentDecision = await runClassificationAgent({
        sourcePath,
        facts: currentRecord.facts,
        projectContext: project.context,
        availableRelatedDocuments: availableDocuments,
      });
      currentRecord.agentDecision = currentDecision;
      await persistProjectSnapshot(loaded);
      return {
        ...memoryView({
          loaded,
          relatedDocumentCount: availableDocuments.length,
          decisionContextVersion: project.contextState.version,
        }),
        currentDecision,
      };
    }

    await persistProjectSnapshot(loaded);

    const { synthesis, reEvaluatedDocuments } = await rebuildLoadedProject(
      loaded,
      params,
      sourcePath,
      'incremental',
      'add_file'
    );
    const availableDocuments = combinedRelatedDocuments(project, []).filter(
      document => document.sourcePath !== sourcePath
    );
    const currentDecision =
      project.documents.get(sourcePath)?.agentDecision ??
      (await runClassificationAgent({
        sourcePath,
        facts: currentRecord.facts,
        projectContext: project.context,
        availableRelatedDocuments: availableDocuments,
      }));
    currentRecord.agentDecision = currentDecision;
    // rebuildLoadedProject 已将 Context 和最新 Agent 建议写入同一个快照。
    return {
      ...memoryView({
        loaded,
        relatedDocumentCount: availableDocuments.length,
        reEvaluatedDocuments,
        synthesis,
      }),
      currentDecision,
    };
  });
}

/** 兼容测试和内部调用：按“先评估、后提交”顺序完成一次完整生命周期。 */
export async function rememberAndEvaluateProjectDocument(
  params: CommitArchivedProjectDocumentParams
): Promise<RememberAndEvaluateResult> {
  await evaluateProjectDocumentCandidate(params);
  return commitArchivedProjectDocument(params);
}

export async function clearSessionProjectMemory(
  projectId: string
): Promise<boolean> {
  const normalizedProjectId = projectId.trim();
  const localDeleted = memoryStore().projects.delete(normalizedProjectId);
  await clearDurableProjectMemory(normalizedProjectId);
  return localDeleted;
}

async function persistDirtyState(
  loaded: LoadedProject,
  reason: string
): Promise<void> {
  const { project } = loaded;
  const now = Math.max(
    Date.now(),
    (project.contextState.updatedAt ?? project.contextState.lastAttemptAt ?? 0) +
      1
  );
  if (!project.context) {
    const fallback = await synthesizeProjectContext({
      projectName: project.projectId,
      documents: combinedRelatedDocuments(project, []),
      allowLlm: false,
    });
    project.context = fallback.context;
  }
  project.contextState = {
    ...project.contextState,
    status: 'dirty',
    dirtyReasons: [...new Set([...project.contextState.dirtyReasons, reason])],
    lastError: undefined,
  };
  project.updatedAt = now;
  memoryStore().projects.set(project.projectId, project);
  await persistProjectSnapshot(loaded);
}

export async function markProjectContextDirty(
  projectId: string,
  reason: string
): Promise<ProjectSessionMemoryView> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error('标记Context需要有效的项目ID');
  return withProjectLock(normalizedProjectId, async () => {
    const loaded = await loadProjectRecord(normalizedProjectId);
    await persistDirtyState(loaded, reason.trim() || '项目档案发生变化');
    return memoryView({ loaded });
  });
}

export async function forgetProjectDocument(
  projectId: string,
  sourcePath: string,
  options: ProjectMemoryMutationContext = {}
): Promise<boolean> {
  void options;
  const normalizedProjectId = projectId.trim();
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  if (!normalizedProjectId || !normalizedSourcePath) return false;
  return withProjectLock(normalizedProjectId, async () => {
    const loaded = await loadProjectRecord(normalizedProjectId);
    const { project } = loaded;
    const existed = project.documents.delete(normalizedSourcePath);
    project.revision += 1;
    recordPendingChange(project, 'deleted', normalizedSourcePath);
    await persistDirtyState(
      loaded,
      `已删除文件“${normalizedSourcePath}”，正式Context尚未重建`
    );
    return existed;
  });
}

export async function forgetProjectDocumentByArchivedFileId(
  projectId: string,
  archivedFileId: string,
  options: ProjectMemoryMutationContext = {}
): Promise<boolean> {
  void options;
  const normalizedProjectId = projectId.trim();
  const normalizedArchivedFileId = archivedFileId.trim();
  if (!normalizedProjectId || !normalizedArchivedFileId) return false;
  return withProjectLock(normalizedProjectId, async () => {
    const loaded = await loadProjectRecord(normalizedProjectId);
    const { project } = loaded;
    const record = [...project.documents.values()].find(
      document => document.archivedFileId === normalizedArchivedFileId
    );
    if (!record) {
      await persistDirtyState(
        loaded,
        `归档文件 ${normalizedArchivedFileId} 已删除，但旧项目记忆缺少精确关联`
      );
      return false;
    }
    project.documents.delete(record.sourcePath);
    project.revision += 1;
    recordPendingChange(project, 'deleted', record.sourcePath);
    await persistDirtyState(
      loaded,
      `已删除文件“${record.sourcePath}”，正式Context尚未重建`
    );
    return true;
  });
}

export async function forgetProjectDocumentsByFileName(
  projectId: string,
  fileName: string,
  options: ProjectMemoryMutationContext = {}
): Promise<number> {
  void options;
  const normalizedProjectId = projectId.trim();
  const normalizedFileName = fileName.trim();
  if (!normalizedProjectId || !normalizedFileName) return 0;
  return withProjectLock(normalizedProjectId, async () => {
    const loaded = await loadProjectRecord(normalizedProjectId);
    const { project } = loaded;
    const paths = new Set<string>(project.documents.keys());
    const matchingPaths = [...paths].filter(
      path => path.split('/').pop() === normalizedFileName
    );
    if (matchingPaths.length > 1) {
      console.warn(
        `文件名“${normalizedFileName}”对应 ${matchingPaths.length} 条项目记忆，缺少精确 sourcePath，本次不自动删除记忆`
      );
      await persistDirtyState(
        loaded,
        `文件“${normalizedFileName}”已删除，但存在多个同名事实，需要人工重建Context`
      );
      return 0;
    }
    for (const sourcePath of matchingPaths) {
      project.documents.delete(sourcePath);
    }
    project.revision += matchingPaths.length;
    for (const sourcePath of matchingPaths) {
      recordPendingChange(project, 'deleted', sourcePath);
    }
    await persistDirtyState(
      loaded,
      matchingPaths.length > 0
        ? `已删除文件“${normalizedFileName}”，正式Context尚未重建`
        : `归档文件“${normalizedFileName}”已删除，但旧项目记忆没有对应事实`
    );
    return matchingPaths.length;
  });
}

export async function getProjectContextMemoryView(
  projectId: string
): Promise<ProjectSessionMemoryView> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error('读取Context需要有效的项目ID');
  return withProjectLock(normalizedProjectId, async () =>
    memoryView({ loaded: await loadProjectRecord(normalizedProjectId) })
  );
}

export async function rebuildProjectContext(
  projectId: string,
  options: ProjectMemoryMutationContext = {}
): Promise<ProjectSessionMemoryView> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error('重建Context需要有效的项目ID');
  return withProjectLock(normalizedProjectId, async () => {
    const loaded = await loadProjectRecord(normalizedProjectId);
    const { synthesis, reEvaluatedDocuments } = await rebuildLoadedProject(
      loaded,
      options,
      undefined,
      'full',
      'manual'
    );
    return memoryView({ loaded, synthesis, reEvaluatedDocuments });
  });
}

export function getSessionProjectMemorySnapshot(projectId: string): {
  projectId: string;
  revision: number;
  documentCount: number;
  documents: Array<{
    sourcePath: string;
    documentType: DocumentFacts['documentType'];
    agentStatus: ClassificationAgentResult['status'] | null;
    selectedFolder: string | null;
  }>;
} | null {
  const project = memoryStore().projects.get(projectId.trim());
  if (!project) return null;
  return {
    projectId: project.projectId,
    revision: project.revision,
    documentCount: project.documents.size,
    documents: [...project.documents.values()].map(document => ({
      sourcePath: document.sourcePath,
      documentType: document.facts.documentType,
      agentStatus: document.agentDecision?.status ?? null,
      selectedFolder: selectedFolderName(document.agentDecision),
    })),
  };
}

/** 仅清空当前进程缓存，用于模拟服务重启；不会删除 S3 记忆。 */
export function clearAllSessionProjectMemoryForTests(): void {
  const store = memoryStore();
  store.projects.clear();
  store.projectLocks.clear();
}
