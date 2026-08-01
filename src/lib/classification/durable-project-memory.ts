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
  facts: DocumentFacts;
  agentDecision: ClassificationAgentResult | null;
  firstSeenAt: number;
  updatedAt: number;
}

export interface DurableProjectSnapshot {
  projectId: string;
  context: ProjectContextSnapshot | null;
  documents: Map<string, DurableDocumentRecord>;
  revision: number;
}

interface PersistedDocumentVersion extends DurableDocumentRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: 'document-version';
  projectId: string;
  revisionId: string;
}

interface PersistedContextVersion {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: 'context-version';
  projectId: string;
  revisionId: string;
  context: ProjectContextSnapshot;
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

function parseDocumentVersion(value: Buffer): PersistedDocumentVersion | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<PersistedDocumentVersion>;
    const facts = DocumentFactsSchema.safeParse(parsed.facts);
    if (
      parsed.schemaVersion !== MEMORY_SCHEMA_VERSION ||
      parsed.kind !== 'document-version' ||
      typeof parsed.projectId !== 'string' ||
      typeof parsed.revisionId !== 'string' ||
      typeof parsed.sourcePath !== 'string' ||
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
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
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

export async function appendDurableContextVersion(params: {
  projectId: string;
  context: ProjectContextSnapshot;
  updatedAt: number;
}): Promise<void> {
  const revisionId = randomUUID();
  const value: PersistedContextVersion = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'context-version',
    projectId: params.projectId,
    revisionId,
    context: params.context,
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
  const [documentVersions, contextVersions] = await Promise.all([
    readInBatches(documentKeys, parseDocumentVersion),
    readInBatches(contextKeys, parseContextVersion),
  ]);
  const documents = new Map<string, DurableDocumentRecord>();
  for (const version of documentVersions) {
    if (version.projectId !== projectId) continue;
    const existing = documents.get(version.sourcePath);
    if (!existing || version.updatedAt >= existing.updatedAt) {
      documents.set(version.sourcePath, {
        sourcePath: version.sourcePath,
        facts: version.facts,
        agentDecision: version.agentDecision,
        firstSeenAt: version.firstSeenAt,
        updatedAt: version.updatedAt,
      });
    }
  }
  const context = contextVersions
    .filter(version => version.projectId === projectId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.context ?? null;
  return {
    projectId,
    context,
    documents,
    revision: documentVersions.filter(version => version.projectId === projectId)
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
