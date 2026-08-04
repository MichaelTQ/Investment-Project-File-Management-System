import { createHash, randomUUID } from 'node:crypto';

import {
  deleteStoredFilesByPrefix,
  listStoredFilesByPrefix,
  readStoredFile,
  deleteStoredFile,
  writeStoredFile,
} from '../storage';
import type { ClassificationAgentResult } from './classification-agent';

export interface RebuildHistoryEntry {
  /** 重建触发：add_file / delete_file / manual */
  trigger: 'add_file' | 'delete_file' | 'manual';
  /** 重建时间戳 */
  timestamp: number;
  /** 总耗时 (ms) */
  totalDurationMs: number;
  /** LLM 综合阶段耗时 (ms) */
  synthesisDurationMs: number;
  /** 重评估阶段耗时 (ms) */
  reevaluationDurationMs: number;
  /** LLM 调用次数 */
  llmCallCount: number;
  /** LLM 输入 tokens */
  inputTokens: number;
  /** LLM 输出 tokens */
  outputTokens: number;
  /** 参与综合的文档数 */
  inputDocumentCount: number;
  /** 实际纳入的文档数 */
  includedDocumentCount: number;
  /** 重评估模式 */
  reevaluationMode: 'incremental' | 'full';
  /** 总文档数 */
  totalDocumentCount: number;
  /** 实际重评估的文档数 */
  reEvaluatedDocumentCount: number;
  /** 重评估后决策变更的文档数 */
  changedDecisionCount: number;
  /** 重建结果 */
  status: 'success' | 'failed';
  /** Context 版本（重建后） */
  contextVersion: number;
  /** Context 状态来源 */
  contextStatus: 'llm_synthesized' | 'deterministic_fallback';
  /** 重建前阶段 → 重建后阶段 */
  stageTransition?: { from: string; to: string };
  /** 错误信息（失败时） */
  error?: string;
}

export const MAX_REBUILD_HISTORY = 50;
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
  rebuildHistory: RebuildHistoryEntry[];
  revision: number;
  loadedFrom?: 'snapshot' | 'legacy';
  snapshotUpdatedAt?: number;
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
  pendingChanges?: {
    fromRevision: number;
    toRevision: number;
    added: string[];
    deleted: string[];
    moved: string[];
  };
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

interface PersistedProjectSnapshot {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: 'project-snapshot';
  projectId: string;
  revision: number;
  context: ProjectContextSnapshot | null;
  contextState: ProjectContextLifecycleState;
  documents: DurableDocumentRecord[];
  rebuildHistory?: RebuildHistoryEntry[];
  updatedAt: number;
}

interface PersistedProjectRevision {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: 'project-revision';
  projectId: string;
  revision: number;
  updatedAt: number;
}

export interface DurableProjectMemoryBackend {
  write(storageKey: string, value: Buffer): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  delete(storageKey: string): Promise<void>;
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
  delete: deleteStoredFile,
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

function snapshotKey(projectId: string): string {
  return `${projectPrefix(projectId)}/snapshot.json`;
}

function revisionKey(projectId: string): string {
  return `${projectPrefix(projectId)}/revision.json`;
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

function parseRebuildHistory(raw: unknown): RebuildHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RebuildHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<RebuildHistoryEntry>;
    if (
      typeof entry.timestamp !== 'number' ||
      typeof entry.totalDurationMs !== 'number' ||
      typeof entry.synthesisDurationMs !== 'number' ||
      typeof entry.reevaluationDurationMs !== 'number' ||
      typeof entry.llmCallCount !== 'number' ||
      typeof entry.inputTokens !== 'number' ||
      typeof entry.outputTokens !== 'number' ||
      typeof entry.inputDocumentCount !== 'number' ||
      typeof entry.includedDocumentCount !== 'number' ||
      typeof entry.totalDocumentCount !== 'number' ||
      typeof entry.reEvaluatedDocumentCount !== 'number' ||
      typeof entry.changedDecisionCount !== 'number' ||
      typeof entry.contextVersion !== 'number' ||
      !['add_file', 'delete_file', 'manual'].includes(entry.trigger ?? '') ||
      !['incremental', 'full'].includes(entry.reevaluationMode ?? '') ||
      !['success', 'failed'].includes(entry.status ?? '') ||
      !['llm_synthesized', 'deterministic_fallback'].includes(entry.contextStatus ?? '')
    ) {
      continue;
    }
    entries.push(entry as RebuildHistoryEntry);
  }
  return entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_REBUILD_HISTORY);
}

function parseProjectSnapshot(value: Buffer): DurableProjectSnapshot | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<PersistedProjectSnapshot>;
    const context =
      parsed.context === null
        ? { success: true as const, data: null }
        : ProjectContextSnapshotSchema.safeParse(parsed.context);
    const contextState = parseContextState(parsed.contextState);
    if (
      parsed.schemaVersion !== MEMORY_SCHEMA_VERSION ||
      parsed.kind !== 'project-snapshot' ||
      typeof parsed.projectId !== 'string' ||
      typeof parsed.revision !== 'number' ||
      !context.success ||
      !contextState ||
      !Array.isArray(parsed.documents)
    ) {
      return null;
    }
    const documents = new Map<string, DurableDocumentRecord>();
    for (const candidate of parsed.documents) {
      if (!candidate || typeof candidate !== 'object') return null;
      const record = candidate as Partial<DurableDocumentRecord>;
      const facts = DocumentFactsSchema.safeParse(record.facts);
      if (
        typeof record.sourcePath !== 'string' ||
        (record.archivedFileId !== undefined &&
          typeof record.archivedFileId !== 'string') ||
        typeof record.firstSeenAt !== 'number' ||
        typeof record.updatedAt !== 'number' ||
        !facts.success ||
        (record.agentDecision !== null &&
          record.agentDecision !== undefined &&
          !isAgentDecision(record.agentDecision))
      ) {
        return null;
      }
      documents.set(record.sourcePath, {
        sourcePath: record.sourcePath,
        archivedFileId: record.archivedFileId,
        facts: facts.data,
        agentDecision: record.agentDecision ?? null,
        firstSeenAt: record.firstSeenAt,
        updatedAt: record.updatedAt,
      });
    }
    return {
      projectId: parsed.projectId,
      revision: Math.max(0, Math.round(parsed.revision)),
      context: context.data,
      contextState,
      documents,
      rebuildHistory: parseRebuildHistory(parsed.rebuildHistory),
      loadedFrom: 'snapshot',
      snapshotUpdatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function parseProjectRevision(value: Buffer): PersistedProjectRevision | null {
  try {
    const parsed = JSON.parse(
      value.toString('utf8')
    ) as Partial<PersistedProjectRevision>;
    return parsed.schemaVersion === MEMORY_SCHEMA_VERSION &&
      parsed.kind === 'project-revision' &&
      typeof parsed.projectId === 'string' &&
      typeof parsed.revision === 'number' &&
      typeof parsed.updatedAt === 'number'
      ? {
          schemaVersion: MEMORY_SCHEMA_VERSION,
          kind: 'project-revision',
          projectId: parsed.projectId,
          revision: Math.max(0, Math.round(parsed.revision)),
          updatedAt: parsed.updatedAt,
        }
      : null;
  } catch {
    return null;
  }
}

async function loadLatestProjectSnapshot(
  projectId: string
): Promise<DurableProjectSnapshot | null> {
  const keys = await backend.list(snapshotKey(projectId).replace(/\.json$/, ''));
  const snapshots = (await readInBatches(keys, parseProjectSnapshot))
    .filter(snapshot => snapshot.projectId === projectId)
    .sort(
      (left, right) =>
        (right.snapshotUpdatedAt ?? 0) - (left.snapshotUpdatedAt ?? 0) ||
        right.contextState.version - left.contextState.version
    );
  return snapshots[0] ?? null;
}

async function deletePreviousObjects(
  previousKeys: string[],
  currentKey: string
): Promise<void> {
  await Promise.all(
    previousKeys
      .filter(key => key !== currentKey)
      .map(key => backend.delete(key))
  );
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
    pendingChanges: parsePendingChanges(candidate.pendingChanges),
  };
}

function parsePendingChanges(
  value: unknown
): ProjectContextLifecycleState['pendingChanges'] {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const paths = (key: 'added' | 'deleted' | 'moved') => {
    const items = candidate[key];
    return Array.isArray(items) &&
      items.every((item: unknown) => typeof item === 'string')
      ? (items as string[]).slice(0, 500)
      : null;
  };
  const added = paths('added');
  const deleted = paths('deleted');
  const moved = paths('moved');
  if (
    typeof candidate.fromRevision !== 'number' ||
    typeof candidate.toRevision !== 'number' ||
    !added ||
    !deleted ||
    !moved
  ) {
    return undefined;
  }
  return {
    fromRevision: Math.max(0, Math.round(candidate.fromRevision)),
    toRevision: Math.max(0, Math.round(candidate.toRevision)),
    added,
    deleted,
    moved,
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
  try {
    const snapshot = await loadLatestProjectSnapshot(projectId);
    if (snapshot?.projectId === projectId) return snapshot;
  } catch {
    // 尚无快照时兼容读取旧的追加式版本记录，并在下一次写入时完成压缩。
  }

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
    rebuildHistory: [],
    revision: documentEntries.filter(entry => entry.projectId === projectId)
      .length,
    loadedFrom: 'legacy',
  };
}

export async function saveDurableProjectMemorySnapshot(params: {
  projectId: string;
  revision: number;
  context: ProjectContextSnapshot | null;
  contextState: ProjectContextLifecycleState;
  documents: Map<string, DurableDocumentRecord>;
  rebuildHistory: RebuildHistoryEntry[];
  updatedAt: number;
}): Promise<void> {
  const value: PersistedProjectSnapshot = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'project-snapshot',
    projectId: params.projectId,
    revision: params.revision,
    context: params.context,
    contextState: params.contextState,
    documents: [...params.documents.values()],
    rebuildHistory: params.rebuildHistory,
    updatedAt: params.updatedAt,
  };
  const requestedSnapshotKey = snapshotKey(params.projectId);
  const requestedRevisionKey = revisionKey(params.projectId);
  // Coze S3Storage 会自动给上传文件名增加随机后缀，因此必须使用返回的真实 key。
  const [previousSnapshotKeys, previousRevisionKeys] = await Promise.all([
    backend.list(requestedSnapshotKey.replace(/\.json$/, '')),
    backend.list(requestedRevisionKey.replace(/\.json$/, '')),
  ]);
  const actualSnapshotKey = await backend.write(
    requestedSnapshotKey,
    encode(value)
  );
  const verified = parseProjectSnapshot(await backend.read(actualSnapshotKey));
  if (
    !verified ||
    verified.projectId !== params.projectId ||
    verified.revision !== params.revision ||
    verified.documents.size !== params.documents.size
  ) {
    throw new Error('S3 项目记忆快照写入后校验失败');
  }
  const revision: PersistedProjectRevision = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'project-revision',
    projectId: params.projectId,
    revision: params.revision,
    updatedAt: params.updatedAt,
  };
  const actualRevisionKey = await backend.write(
    requestedRevisionKey,
    encode(revision)
  );
  const verifiedRevision = parseProjectRevision(
    await backend.read(actualRevisionKey)
  );
  if (
    !verifiedRevision ||
    verifiedRevision.projectId !== params.projectId ||
    verifiedRevision.revision !== params.revision
  ) {
    throw new Error('S3 项目记忆版本标记写入后校验失败');
  }
  // 只删除本次写入前已经列出的旧对象；不会误删并发实例刚写入的新快照。
  await Promise.all([
    deletePreviousObjects(previousSnapshotKeys, actualSnapshotKey),
    deletePreviousObjects(previousRevisionKeys, actualRevisionKey),
  ]);
}

export async function loadDurableProjectRevision(
  projectId: string
): Promise<number | null> {
  try {
    const keys = await backend.list(revisionKey(projectId).replace(/\.json$/, ''));
    const revisions = (await readInBatches(keys, parseProjectRevision))
      .filter(revision => revision.projectId === projectId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return revisions[0]?.revision ?? null;
  } catch {
    return null;
  }
}

/** 新快照已验证后，清理旧追加式日志；不会触碰 snapshot.json 或业务文件。 */
export async function compactLegacyProjectMemory(projectId: string): Promise<void> {
  const verified = await loadLatestProjectSnapshot(projectId);
  if (!verified || verified.projectId !== projectId) {
    throw new Error('项目记忆快照尚未验证，禁止清理历史版本');
  }
  const prefix = projectPrefix(projectId);
  await Promise.all([
    backend.deletePrefix(`${prefix}/documents/`),
    backend.deletePrefix(`${prefix}/contexts/`),
  ]);
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
