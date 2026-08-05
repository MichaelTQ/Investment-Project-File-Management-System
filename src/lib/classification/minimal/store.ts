import { createHash } from 'node:crypto';

import type { ArchiveBusinessStage } from '../../folder-structure';
import {
  deleteStoredFile,
  listStoredFilesByPrefix,
  readStoredFile,
  writeStoredFile,
} from '../../storage';
import { DocumentFactsSchema, type DocumentFacts } from '../document-facts';

/**
 * 极简项目档案存储。
 *
 * 按方案第 6 节，每个项目只持久化三样东西：每份文件的事实、每份文件当前的归档
 * 阶段、用户已忽略的提示。没有版本号、没有快照生命周期、没有重建历史——那些是
 * 为"增量重建 + 多端一致性"服务的，初筛场景用不到。
 *
 * 整个项目一个 JSON，整读整写。100 份文件以内这样最简单也最快；超过之后再谈分片。
 */

const ARCHIVE_ROOT = 'minimal-archive/v1/projects';
const SCHEMA_VERSION = 1 as const;

export interface MinimalDocument {
  sourcePath: string;
  facts: DocumentFacts;
  /** 文件当前实际归在哪个阶段。null 表示尚未归档。 */
  stage: ArchiveBusinessStage | null;
  archivedFileId?: string;
  /** 内容指纹，用于识别重复文件。 */
  fingerprint?: string;
  updatedAt: number;
}

export interface MinimalProjectArchive {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  updatedAt: number;
  documents: MinimalDocument[];
  /** 已被用户忽略的提示，格式为 `${kind}:${sourcePath}`。 */
  dismissedFindings: string[];
}

interface StoreBackend {
  write(storageKey: string, value: Buffer): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  delete(storageKey: string): Promise<void>;
}

const s3Backend: StoreBackend = {
  write: (storageKey, value) =>
    writeStoredFile({
      buffer: value,
      storageKey,
      mimeType: 'application/json; charset=utf-8',
    }),
  read: readStoredFile,
  list: listStoredFilesByPrefix,
  delete: deleteStoredFile,
};

let backend: StoreBackend = s3Backend;

/** 测试用：替换存储后端。 */
export function setMinimalArchiveBackendForTests(
  replacement: StoreBackend | null
): void {
  backend = replacement ?? s3Backend;
}

function archiveKeyBase(projectId: string): string {
  const projectHash = createHash('sha256').update(projectId).digest('hex');
  return `${ARCHIVE_ROOT}/${projectHash}/archive`;
}

function emptyArchive(projectId: string): MinimalProjectArchive {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    updatedAt: 0,
    documents: [],
    dismissedFindings: [],
  };
}

function parseArchive(
  value: Buffer,
  projectId: string
): MinimalProjectArchive | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (parsed.projectId !== projectId) return null;
    if (!Array.isArray(parsed.documents)) return null;

    const documents: MinimalDocument[] = [];
    for (const entry of parsed.documents) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.sourcePath !== 'string' || !record.sourcePath) continue;
      const facts = DocumentFactsSchema.safeParse(record.facts);
      // 事实结构变了就丢掉这条，下次上传会重抽。宁可少一条也不要喂坏数据给校验器。
      if (!facts.success) continue;
      documents.push({
        sourcePath: record.sourcePath,
        facts: facts.data,
        stage: (record.stage as ArchiveBusinessStage | null) ?? null,
        archivedFileId:
          typeof record.archivedFileId === 'string'
            ? record.archivedFileId
            : undefined,
        fingerprint:
          typeof record.fingerprint === 'string' ? record.fingerprint : undefined,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      });
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      projectId,
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      documents,
      dismissedFindings: Array.isArray(parsed.dismissedFindings)
        ? parsed.dismissedFindings.filter(
            (item): item is string => typeof item === 'string'
          )
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * S3 上传会给 key 追加随机后缀，同一个逻辑文件会留下多个物理对象。
 * 读取时列出前缀下全部对象，取 updatedAt 最新的一个，并顺手清掉旧的。
 */
async function loadFromBackend(
  projectId: string
): Promise<{ archive: MinimalProjectArchive; staleKeys: string[] }> {
  const keys = await backend.list(archiveKeyBase(projectId));
  if (keys.length === 0) {
    return { archive: emptyArchive(projectId), staleKeys: [] };
  }

  const loaded = await Promise.all(
    keys.map(async key => {
      try {
        return { key, archive: parseArchive(await backend.read(key), projectId) };
      } catch {
        return { key, archive: null };
      }
    })
  );

  const valid = loaded
    .filter(
      (item): item is { key: string; archive: MinimalProjectArchive } =>
        item.archive !== null
    )
    .sort((left, right) => right.archive.updatedAt - left.archive.updatedAt);

  if (valid.length === 0) {
    return { archive: emptyArchive(projectId), staleKeys: keys };
  }
  return {
    archive: valid[0].archive,
    staleKeys: keys.filter(key => key !== valid[0].key),
  };
}

async function saveToBackend(
  archive: MinimalProjectArchive,
  staleKeys: string[]
): Promise<void> {
  const written = await backend.write(
    `${archiveKeyBase(archive.projectId)}.json`,
    Buffer.from(JSON.stringify(archive), 'utf8')
  );
  await Promise.all(
    staleKeys
      .filter(key => key !== written)
      .map(key => backend.delete(key).catch(() => undefined))
  );
}

const locks = new Map<string, Promise<unknown>>();

/** 同一项目的读改写串行执行，避免并发上传互相覆盖。 */
async function withProjectLock<T>(
  projectId: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const current = previous.then(action, action);
  locks.set(
    projectId,
    current.catch(() => undefined)
  );
  try {
    return await current;
  } finally {
    if (locks.get(projectId) === current) locks.delete(projectId);
  }
}

export async function loadMinimalArchive(
  projectId: string
): Promise<MinimalProjectArchive> {
  const normalized = projectId.trim();
  if (!normalized) return emptyArchive(projectId);
  return withProjectLock(normalized, async () => {
    const { archive } = await loadFromBackend(normalized);
    return archive;
  });
}

export interface UpsertMinimalDocumentParams {
  projectId: string;
  sourcePath: string;
  facts: DocumentFacts;
  stage?: ArchiveBusinessStage | null;
  archivedFileId?: string;
  fingerprint?: string;
}

export async function upsertMinimalDocument(
  params: UpsertMinimalDocumentParams
): Promise<MinimalProjectArchive> {
  const normalized = params.projectId.trim();
  if (!normalized) throw new Error('写入极简档案需要有效的项目ID');

  return withProjectLock(normalized, async () => {
    const { archive, staleKeys } = await loadFromBackend(normalized);
    const existing = archive.documents.find(
      document => document.sourcePath === params.sourcePath
    );
    const next: MinimalDocument = {
      sourcePath: params.sourcePath,
      facts: params.facts,
      // 未显式给出阶段时保留原值，避免重抽事实把用户手动改过的位置冲掉。
      stage: params.stage !== undefined ? params.stage : existing?.stage ?? null,
      archivedFileId: params.archivedFileId ?? existing?.archivedFileId,
      fingerprint: params.fingerprint ?? existing?.fingerprint,
      updatedAt: Date.now(),
    };

    archive.documents = [
      ...archive.documents.filter(
        document => document.sourcePath !== params.sourcePath
      ),
      next,
    ];
    archive.updatedAt = Date.now();
    await saveToBackend(archive, staleKeys);
    return archive;
  });
}

export async function dismissMinimalFinding(
  projectId: string,
  findingKey: string
): Promise<MinimalProjectArchive> {
  const normalized = projectId.trim();
  if (!normalized) throw new Error('忽略提示需要有效的项目ID');

  return withProjectLock(normalized, async () => {
    const { archive, staleKeys } = await loadFromBackend(normalized);
    if (!archive.dismissedFindings.includes(findingKey)) {
      archive.dismissedFindings.push(findingKey);
      archive.updatedAt = Date.now();
      await saveToBackend(archive, staleKeys);
    }
    return archive;
  });
}

export async function forgetMinimalDocument(
  projectId: string,
  sourcePath: string
): Promise<MinimalProjectArchive> {
  const normalized = projectId.trim();
  if (!normalized) throw new Error('删除档案条目需要有效的项目ID');

  return withProjectLock(normalized, async () => {
    const { archive, staleKeys } = await loadFromBackend(normalized);
    const remaining = archive.documents.filter(
      document => document.sourcePath !== sourcePath
    );
    if (remaining.length !== archive.documents.length) {
      archive.documents = remaining;
      archive.updatedAt = Date.now();
      await saveToBackend(archive, staleKeys);
    }
    return archive;
  });
}
