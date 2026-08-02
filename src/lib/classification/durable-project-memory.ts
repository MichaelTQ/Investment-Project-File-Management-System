import { createHash, randomUUID } from 'node:crypto';

import {
  deleteStoredFilesByPrefix,
  listStoredFilesByPrefix,
  readStoredFile,
  writeStoredFile,
} from '../storage';
import type { ClassificationAgentResult } from './classification-agent';
import {
  ProjectContextSnapshotSchema,
  type ProjectContextSnapshot,
} from './context-decision';
import {
  DocumentFactsSchema,
  type DocumentFacts,
} from './document-facts';

const MEMORY_ROOT = 'agent-memory/v1/projects';
const MEMORY_SCHEMA_VERSION = 1 as const;

export interface DurableDocumentRecord {
  sourcePath: string;
  archivedFileId?: string;
  facts: DocumentFacts;
  agentDecision: ClassificationAgentResult | null;
  firstSeenAt: number;
  updatedAt: number;
}

export interface DurableProjectSnapshot {
  projectId: string;
  context: ProjectContextSnapshot | null;
  contextState: ProjectContextLifecycleState;
  documents: Map<string, DurableDocumentRecord>;
  revision: number;
}

export type ProjectContextLifecycleStatus =
  | 'clean'
  | 'dirty'
  | 'rebuilding'
  | 'failed';

export interface ProjectContextLifecycleState {
  status: ProjectContextLifecycleStatus;
  version: number;
  basedOnRevision: number;
  dirtyReasons: string[];
  updatedAt: number | null;
  lastAttemptAt: number | null;
  lastError?: string;
}

interface PersistedDocumentVersion extends DurableDocumentRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: 'document-version';
  projectId: string;
  revisionId: string;
}

interface PersistedDocumentTombstone {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: 'document-tombstone';
  projectId: string;
  revisionId: string;
  sourcePath: string;
  updatedAt: number;
}

type PersistedDocumentEntry =
  | PersistedDocumentVersion
  | PersistedDocumentTombstone;

interface PersistedContextVersion {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: 'context-version';
  projectId: string;
  revisionId: string;
  context: ProjectContextSnapshot;
  contextState?: ProjectContextLifecycleState;
  updatedAt: number;
}

export interface DurableProjectMemoryBackend {
  write(storageKey: string, value: Buffer): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
}

const s3Backend: DurableProjectMemoryBackend = {
  write: (storageKey, value) =>
    writeStoredFile({
      buffer: value,
      storageKey,
      mimeType: 'application/json; charset=utf-8',
    }),
  read: readStoredFile,
  list: listStoredFilesByPrefix,
  deletePrefix: deleteStoredFilesByPrefix,
};

let backend: DurableProjectMemoryBackend = s3Backend;

function projectPrefix(projectId: string): string {
  const projectHash = createHash('sha256').update(projectId).digest('hex');
  return `${MEMORY_ROOT}/${projectHash}`;
}

function versionKey(projectId: string, kind: 'documents' | 'contexts'): string {
  return `${projectPrefix(projectId)}/${kind}/${Date.now()}-${randomUUID()}.json`;
}

function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function isAgentDecision(value: unknown): value is ClassificationAgentResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ClassificationAgentResult>;
  return (
    (candidate.status === 'decided' || candidate.status === 'needs_review') &&
    typeof candidate.graphVersion === 'string' &&
    typeof candidate.rounds === 'number' &&
    typeof candidate.llmCallCount === 'number' &&
    !!candidate.decision &&
    Array.isArray(candidate.trace) &&
    Array.isArray(candidate.selectedRelatedDocuments) &&
    Array.isArray(candidate.requestedEvidence)
  );
}

function parseDocumentEntry(value: Buffer): PersistedDocumentEntry | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
    if (
      parsed.schemaVersion === MEMORY_SCHEMA_VERSION &&
      parsed.kind === 'document-tombstone' &&
      typeof parsed.projectId === 'string' &&
      typeof parsed.revisionId === 'string' &&
      typeof parsed.sourcePath === 'string' &&
      typeof parsed.updatedAt === 'number'
    ) {
      return {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        kind: 'document-tombstone',
        projectId: parsed.projectId,
        revisionId: parsed.revisionId,
        sourcePath: parsed.sourcePath,
        updatedAt: parsed.updatedAt,
      };
    }
    const facts = DocumentFactsSchema.safeParse(parsed.facts);
    if (
      parsed.schemaVersion !== MEMORY_SCHEMA_VERSION ||
      parsed.kind !== 'document-version' ||
      typeof parsed.projectId !== 'string' ||
      typeof parsed.revisionId !== 'string' ||
      typeof parsed.sourcePath !== 'string' ||
      (parsed.archivedFileId !== undefined &&
        typeof parsed.archivedFileId !== 'string') ||
      typeof parsed.firstSeenAt !== 'number' ||
      typeof parsed.updatedAt !== 'number' ||
      !facts.success ||
      (parsed.agentDecision !== null && !isAgentDecision(parsed.agentDecision))
    ) {
      return null;
    }
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: 'document-version',
      projectId: parsed.projectId,
      revisionId: parsed.revisionId,
      sourcePath: parsed.sourcePath,
      archivedFileId: parsed.archivedFileId,
      facts: facts.data,
      agentDecision: parsed.agentDecision,
      firstSeenAt: parsed.firstSeenAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function parseContextVersion(value: Buffer): PersistedContextVersion | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<PersistedContextVersion>;
    const context = ProjectContextSnapshotSchema.safeParse(parsed.context);
    if (
      parsed.schemaVersion !== MEMORY_SCHEMA_VERSION ||
      parsed.kind !== 'context-version' ||
      typeof parsed.projectId !== 'string' ||
      typeof parsed.revisionId !== 'string' ||
      typeof parsed.updatedAt !== 'number' ||
      !context.success
    ) {
      return null;
    }
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: 'context-version',
      projectId: parsed.projectId,
      revisionId: parsed.revisionId,
      context: context.data,
      contextState: parseContextState(parsed.contextState),
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function parseContextState(value: unknown): ProjectContextLifecycleState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ProjectContextLifecycleState>;
  if (
    !['clean', 'dirty', 'rebuilding', 'failed'].includes(
      candidate.status ?? ''
    ) ||
    typeof candidate.version !== 'number' ||
    typeof candidate.basedOnRevision !== 'number' ||
    !Array.isArray(candidate.dirtyReasons) ||
    !candidate.dirtyReasons.every(reason => typeof reason === 'string') ||
    (candidate.updatedAt !== null && typeof candidate.updatedAt !== 'number') ||
    (candidate.lastAttemptAt !== null &&
      typeof candidate.lastAttemptAt !== 'number')
  ) {
    return undefined;
  }
  return {
    status: candidate.status as ProjectContextLifecycleStatus,
    version: Math.max(0, Math.round(candidate.version)),
    basedOnRevision: Math.max(0, Math.round(candidate.basedOnRevision)),
    dirtyReasons: candidate.dirtyReasons.slice(0, 100),
    updatedAt: candidate.updatedAt,
    lastAttemptAt: candidate.lastAttemptAt,
    lastError:
      typeof candidate.lastError === 'string' ? candidate.lastError : undefined,
  };
}

async function readInBatches<T>(
  keys: string[],
  parser: (value: Buffer) => T | null
): Promise<T[]> {
  const values: T[] = [];
  for (let index = 0; index < keys.length; index += 20) {
    const batch = keys.slice(index, index + 20);
    const results = await Promise.all(
      batch.map(async key => parser(await backend.read(key)))
    );
    for (const value of results) {
      if (value !== null) values.push(value as T);
    }
  }
  return values;
}

export async function appendDurableDocumentVersion(params: {
  projectId: string;
  record: DurableDocumentRecord;
}): Promise<void> {
  const revisionId = randomUUID();
  const value: PersistedDocumentVersion = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'document-version',
    projectId: params.projectId,
    revisionId,
    ...params.record,
  };
  await backend.write(versionKey(params.projectId, 'documents'), encode(value));
}

export async function appendDurableDocumentTombstone(params: {
  projectId: string;
  sourcePath: string;
  updatedAt?: number;
}): Promise<void> {
  const value: PersistedDocumentTombstone = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'document-tombstone',
    projectId: params.projectId,
    revisionId: randomUUID(),
    sourcePath: params.sourcePath,
    updatedAt: params.updatedAt ?? Date.now(),
  };
  await backend.write(
    versionKey(params.projectId, 'documents'),
    encode(value)
  );
}

export async function appendDurableContextVersion(params: {
  projectId: string;
  context: ProjectContextSnapshot;
  contextState: ProjectContextLifecycleState;
  updatedAt: number;
}): Promise<void> {
  const revisionId = randomUUID();
  const value: PersistedContextVersion = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'context-version',
    projectId: params.projectId,
    revisionId,
    context: params.context,
    contextState: params.contextState,
    updatedAt: params.updatedAt,
  };
  await backend.write(versionKey(params.projectId, 'contexts'), encode(value));
}

export async function loadDurableProjectMemory(
  projectId: string
): Promise<DurableProjectSnapshot> {
  const prefix = projectPrefix(projectId);
  const [documentKeys, contextKeys] = await Promise.all([
    backend.list(`${prefix}/documents/`),
    backend.list(`${prefix}/contexts/`),
  ]);
  const [documentEntries, contextVersions] = await Promise.all([
    readInBatches(documentKeys, parseDocumentEntry),
    readInBatches(contextKeys, parseContextVersion),
  ]);
  const latestEntries = new Map<string, PersistedDocumentEntry>();
  for (const entry of documentEntries) {
    if (entry.projectId !== projectId) continue;
    const existing = latestEntries.get(entry.sourcePath);
    if (
      !existing ||
      entry.updatedAt > existing.updatedAt ||
      (entry.updatedAt === existing.updatedAt &&
        entry.kind === 'document-tombstone')
    ) {
      latestEntries.set(entry.sourcePath, entry);
    }
  }
  const documents = new Map<string, DurableDocumentRecord>();
  for (const entry of latestEntries.values()) {
    if (entry.kind === 'document-tombstone') continue;
    documents.set(entry.sourcePath, {
      sourcePath: entry.sourcePath,
      archivedFileId: entry.archivedFileId,
      facts: entry.facts,
      agentDecision: entry.agentDecision,
      firstSeenAt: entry.firstSeenAt,
      updatedAt: entry.updatedAt,
    });
  }
  const latestContextVersion = contextVersions
    .filter(version => version.projectId === projectId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const context = latestContextVersion?.context ?? null;
  const contextState =
    latestContextVersion?.contextState ??
    (context
      ? {
          status: 'clean' as const,
          version: 1,
          basedOnRevision: documentEntries.filter(
            entry => entry.projectId === projectId
          ).length,
          dirtyReasons: [],
          updatedAt: latestContextVersion?.updatedAt ?? null,
          lastAttemptAt: latestContextVersion?.updatedAt ?? null,
        }
      : {
          status: documents.size > 0 ? ('dirty' as const) : ('clean' as const),
          version: 0,
          basedOnRevision: 0,
          dirtyReasons:
            documents.size > 0 ? ['现有项目事实尚未生成正式Context'] : [],
          updatedAt: null,
          lastAttemptAt: null,
        });
  return {
    projectId,
    context,
    contextState,
    documents,
    revision: documentEntries.filter(entry => entry.projectId === projectId)
      .length,
  };
}

export async function clearDurableProjectMemory(projectId: string): Promise<void> {
  await backend.deletePrefix(`${projectPrefix(projectId)}/`);
}

export function setDurableProjectMemoryBackendForTests(
  replacement: DurableProjectMemoryBackend
): void {
  backend = replacement;
}

export function resetDurableProjectMemoryBackendForTests(): void {
  backend = s3Backend;
}
