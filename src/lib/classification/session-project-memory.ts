import {
  runClassificationAgent,
  type ClassificationAgentResult,
} from './classification-agent';
import type {
  ProjectContextSnapshot,
  RelatedDocumentFacts,
} from './context-decision';
import {
  appendDurableContextVersion,
  appendDurableDocumentTombstone,
  appendDurableDocumentVersion,
  clearDurableProjectMemory,
  loadDurableProjectMemory,
} from './durable-project-memory';
import type { DocumentFacts, DocumentType } from './document-facts';

const DURABLE_MEMORY_MODE = 's3-durable-shadow' as const;
const FALLBACK_MEMORY_MODE = 'process-local-fallback' as const;
const PROJECT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PROJECTS = 50;
const MAX_DOCUMENTS_PER_PROJECT = 200;

interface SessionDocumentRecord {
  sourcePath: string;
  facts: DocumentFacts;
  agentDecision: ClassificationAgentResult | null;
  firstSeenAt: number;
  updatedAt: number;
}

interface SessionProjectRecord {
  projectId: string;
  revision: number;
  context: ProjectContextSnapshot | null;
  documents: Map<string, SessionDocumentRecord>;
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
  previousCategory: string | null;
  selectedCategory: string | null;
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
  selectedCategory: string | null;
}

export interface ProjectSessionMemoryView {
  mode: typeof DURABLE_MEMORY_MODE | typeof FALLBACK_MEMORY_MODE;
  persistent: boolean;
  persistenceWarning?: string;
  projectId: string;
  revision: number;
  documentCount: number;
  relatedDocumentCount: number;
  documents: ProjectMemoryDocumentView[];
  reEvaluatedDocuments: ReEvaluatedDocument[];
  expiresAt?: string;
}

export interface RememberAndEvaluateResult extends ProjectSessionMemoryView {
  currentDecision: ClassificationAgentResult;
}

export interface RememberAndEvaluateParams {
  projectId: string;
  sourcePath: string;
  facts: DocumentFacts;
  projectContext?: ProjectContextSnapshot | null;
  suppliedRelatedDocuments?: RelatedDocumentFacts[];
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

function selectedCategoryName(
  decision: ClassificationAgentResult | null
): string | null {
  return decision?.decision.selectedCategory?.fileName ?? null;
}

function decisionSignature(decision: ClassificationAgentResult | null): string {
  return JSON.stringify({
    status: decision?.status ?? null,
    decisionStatus: decision?.decision.status ?? null,
    folderId: decision?.decision.selectedCategory?.folderId ?? null,
    fileName: selectedCategoryName(decision),
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
      selectedCategory: selectedCategoryName(document.agentDecision),
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
  durable.revision = Math.max(durable.revision, local.revision);
  durable.updatedAt = Math.max(durable.updatedAt, local.updatedAt);
  return durable;
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
      documents: new Map(),
      updatedAt: now,
    }
  );
}

export async function rememberAndEvaluateProjectDocument(
  params: RememberAndEvaluateParams
): Promise<RememberAndEvaluateResult> {
  const projectId = params.projectId.trim();
  const sourcePath = normalizeSourcePath(params.sourcePath);
  if (!projectId) throw new Error('项目记忆需要有效的 projectId');
  if (!sourcePath) throw new Error('项目记忆需要有效的 sourcePath');

  return withProjectLock(projectId, async () => {
    const store = memoryStore();
    const now = Date.now();
    pruneFallbackProjects(store, now);
    let mode: ProjectSessionMemoryView['mode'] = DURABLE_MEMORY_MODE;
    let persistenceWarning: string | undefined;
    let project: SessionProjectRecord;

    try {
      const durable = await loadDurableProjectMemory(projectId);
      const latestUpdate = Math.max(
        now,
        ...[...durable.documents.values()].map(document => document.updatedAt)
      );
      project = mergeProjects(
        {
          projectId,
          revision: durable.revision,
          context: durable.context,
          documents: durable.documents,
          updatedAt: latestUpdate,
        },
        store.projects.get(projectId)
      );
      for (const document of project.documents.values()) {
        document.facts = recoverDocumentType(
          document.sourcePath,
          document.facts
        );
      }
    } catch (error) {
      mode = FALLBACK_MEMORY_MODE;
      persistenceWarning =
        error instanceof Error ? error.message : 'S3 项目记忆暂时不可用';
      console.error('Durable project memory load failed:', error);
      project = fallbackProject(projectId, store.projects.get(projectId), now);
    }

    if (params.projectContext) project.context = params.projectContext;
    const existing = project.documents.get(sourcePath);
    const currentFacts = recoverDocumentType(sourcePath, params.facts);
    project.documents.set(sourcePath, {
      sourcePath,
      facts: currentFacts,
      agentDecision: existing?.agentDecision ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
    });
    project.revision += 1;
    project.updatedAt = now;
    if (mode === FALLBACK_MEMORY_MODE) trimFallbackDocuments(project, sourcePath);
    store.projects.set(projectId, project);

    const availableDocuments = combinedRelatedDocuments(
      project,
      params.suppliedRelatedDocuments ?? []
    );
    const currentRecord = project.documents.get(sourcePath);
    if (!currentRecord) throw new Error('当前文件未写入项目记忆');

    const targets =
      currentFacts.documentType === 'company_charter'
        ? [...project.documents.values()].filter(
            document => document.facts.documentType === 'company_charter'
          )
        : [currentRecord];
    const reEvaluatedDocuments: ReEvaluatedDocument[] = [];
    let currentDecision: ClassificationAgentResult | null = null;

    for (const target of targets) {
      const previousDecision = target.agentDecision;
      const decision = await runClassificationAgent({
        sourcePath: target.sourcePath,
        facts: target.facts,
        projectContext: project.context,
        availableRelatedDocuments: availableDocuments.filter(
          document => document.sourcePath !== target.sourcePath
        ),
      });
      target.agentDecision = decision;
      target.updatedAt = now;
      if (target.sourcePath === sourcePath) currentDecision = decision;
      if (
        target.sourcePath !== sourcePath &&
        previousDecision &&
        decisionSignature(previousDecision) !== decisionSignature(decision)
      ) {
        reEvaluatedDocuments.push({
          sourcePath: target.sourcePath,
          previousStatus: previousDecision.status,
          status: decision.status,
          previousCategory: selectedCategoryName(previousDecision),
          selectedCategory: selectedCategoryName(decision),
          agentDecision: decision,
        });
      }
    }

    if (!currentDecision) {
      currentDecision = await runClassificationAgent({
        sourcePath,
        facts: currentRecord.facts,
        projectContext: project.context,
        availableRelatedDocuments: availableDocuments.filter(
          document => document.sourcePath !== sourcePath
        ),
      });
      currentRecord.agentDecision = currentDecision;
    }

    if (mode === DURABLE_MEMORY_MODE) {
      try {
        await Promise.all([
          ...targets.map(record =>
            appendDurableDocumentVersion({ projectId, record })
          ),
          ...(params.projectContext
            ? [
                appendDurableContextVersion({
                  projectId,
                  context: params.projectContext,
                  updatedAt: now,
                }),
              ]
            : []),
        ]);
      } catch (error) {
        mode = FALLBACK_MEMORY_MODE;
        persistenceWarning =
          error instanceof Error ? error.message : 'S3 项目记忆写入失败';
        console.error('Durable project memory write failed:', error);
      }
    }

    return {
      mode,
      persistent: mode === DURABLE_MEMORY_MODE,
      persistenceWarning,
      projectId,
      revision: project.revision,
      documentCount: project.documents.size,
      relatedDocumentCount: Math.max(0, availableDocuments.length - 1),
      documents: projectDocumentViews(project),
      reEvaluatedDocuments,
      expiresAt:
        mode === FALLBACK_MEMORY_MODE
          ? new Date(project.updatedAt + PROJECT_TTL_MS).toISOString()
          : undefined,
      currentDecision,
    };
  });
}

export async function clearSessionProjectMemory(
  projectId: string
): Promise<boolean> {
  const normalizedProjectId = projectId.trim();
  const localDeleted = memoryStore().projects.delete(normalizedProjectId);
  await clearDurableProjectMemory(normalizedProjectId);
  return localDeleted;
}

export async function forgetProjectDocument(
  projectId: string,
  sourcePath: string
): Promise<boolean> {
  const normalizedProjectId = projectId.trim();
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  if (!normalizedProjectId || !normalizedSourcePath) return false;
  return withProjectLock(normalizedProjectId, async () => {
    await appendDurableDocumentTombstone({
      projectId: normalizedProjectId,
      sourcePath: normalizedSourcePath,
    });
    return (
      memoryStore()
        .projects.get(normalizedProjectId)
        ?.documents.delete(normalizedSourcePath) ?? false
    );
  });
}

export async function forgetProjectDocumentsByFileName(
  projectId: string,
  fileName: string
): Promise<number> {
  const normalizedProjectId = projectId.trim();
  const normalizedFileName = fileName.trim();
  if (!normalizedProjectId || !normalizedFileName) return 0;
  return withProjectLock(normalizedProjectId, async () => {
    const durable = await loadDurableProjectMemory(normalizedProjectId);
    const local = memoryStore().projects.get(normalizedProjectId);
    const paths = new Set<string>([
      ...durable.documents.keys(),
      ...(local ? local.documents.keys() : []),
    ]);
    const matchingPaths = [...paths].filter(
      path => path.split('/').pop() === normalizedFileName
    );
    if (matchingPaths.length > 1) {
      console.warn(
        `文件名“${normalizedFileName}”对应 ${matchingPaths.length} 条项目记忆，缺少精确 sourcePath，本次不自动删除记忆`
      );
      return 0;
    }
    await Promise.all(
      matchingPaths.map(sourcePath =>
        appendDurableDocumentTombstone({
          projectId: normalizedProjectId,
          sourcePath,
        })
      )
    );
    for (const sourcePath of matchingPaths) {
      local?.documents.delete(sourcePath);
    }
    return matchingPaths.length;
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
    selectedCategory: string | null;
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
      selectedCategory: selectedCategoryName(document.agentDecision),
    })),
  };
}

/** 仅清空当前进程缓存，用于模拟服务重启；不会删除 S3 记忆。 */
export function clearAllSessionProjectMemoryForTests(): void {
  const store = memoryStore();
  store.projects.clear();
  store.projectLocks.clear();
}
