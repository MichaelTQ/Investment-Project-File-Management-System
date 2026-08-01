import {
  runClassificationAgent,
  type ClassificationAgentResult,
} from './classification-agent';
import type {
  ProjectContextSnapshot,
  RelatedDocumentFacts,
} from './context-decision';
import type { DocumentFacts } from './document-facts';

const MEMORY_MODE = 'process-local-shadow' as const;
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

export interface ProjectSessionMemoryView {
  mode: typeof MEMORY_MODE;
  projectId: string;
  revision: number;
  documentCount: number;
  relatedDocumentCount: number;
  reEvaluatedDocuments: ReEvaluatedDocument[];
  expiresAt: string;
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

function pruneExpiredProjects(store: SessionMemoryStore, now: number): void {
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

function trimProjectDocuments(
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

export async function rememberAndEvaluateProjectDocument(
  params: RememberAndEvaluateParams
): Promise<RememberAndEvaluateResult> {
  const projectId = params.projectId.trim();
  const sourcePath = normalizeSourcePath(params.sourcePath);
  if (!projectId) throw new Error('会话项目记忆需要有效的 projectId');
  if (!sourcePath) throw new Error('会话项目记忆需要有效的 sourcePath');

  return withProjectLock(projectId, async () => {
    const store = memoryStore();
    const now = Date.now();
    pruneExpiredProjects(store, now);
    let project = store.projects.get(projectId);
    if (!project) {
      project = {
        projectId,
        revision: 0,
        context: null,
        documents: new Map(),
        updatedAt: now,
      };
      store.projects.set(projectId, project);
    }

    if (params.projectContext) project.context = params.projectContext;
    const existing = project.documents.get(sourcePath);
    project.documents.set(sourcePath, {
      sourcePath,
      facts: params.facts,
      agentDecision: existing?.agentDecision ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
    });
    project.revision += 1;
    project.updatedAt = now;
    trimProjectDocuments(project, sourcePath);

    const availableDocuments = combinedRelatedDocuments(
      project,
      params.suppliedRelatedDocuments ?? []
    );
    const currentRecord = project.documents.get(sourcePath);
    if (!currentRecord) throw new Error('当前文件未写入会话项目记忆');

    const targets =
      params.facts.documentType === 'company_charter'
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

    return {
      mode: MEMORY_MODE,
      projectId,
      revision: project.revision,
      documentCount: project.documents.size,
      relatedDocumentCount: Math.max(0, availableDocuments.length - 1),
      reEvaluatedDocuments,
      expiresAt: new Date(project.updatedAt + PROJECT_TTL_MS).toISOString(),
      currentDecision,
    };
  });
}

export function clearSessionProjectMemory(projectId: string): boolean {
  return memoryStore().projects.delete(projectId.trim());
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

export function clearAllSessionProjectMemoryForTests(): void {
  const store = memoryStore();
  store.projects.clear();
  store.projectLocks.clear();
}
