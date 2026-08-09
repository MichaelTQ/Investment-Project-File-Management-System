import { createHash } from 'node:crypto';

import type { ArchiveBusinessStage } from '../../folder-structure';
import {
  deleteStoredFile,
  listStoredFilesByPrefix,
  readStoredFile,
  writeStoredFile,
} from '../../storage';
import {
  DocumentFactsSchema,
  hasContentEvidence,
  type DocumentFacts,
} from '../document-facts';
import { leafName } from '../source-path';

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

/**
 * 归档位置是怎么定下来的。
 *
 * 这个区分很要紧：时间线和冲突复核都会读它。人工确认过的位置值得给面子，推翻它需要
 * 硬证据；而纯靠文件名按命名规范落位的，恰恰是最容易错的一类（规范里那八个跨阶段
 * 词条就是明证），必须反过来主动质疑。两者混作一谈的话，最不可靠的判断会被当成
 * 最可信的证据。
 */
export type StageSource = 'human' | 'naming_rule';

export interface MinimalDocument {
  sourcePath: string;
  facts: DocumentFacts;
  /** 文件当前实际归在哪个阶段。null 表示尚未归档。 */
  stage: ArchiveBusinessStage | null;
  /** 这个阶段是谁定的。缺省按人工确认处理，兼容这个字段出现之前的历史条目。 */
  stageSource?: StageSource;
  archivedFileId?: string;
  /** 内容指纹，用于识别重复文件。 */
  fingerprint?: string;
  /**
   * 有没有真读过这份文件的内容。
   *
   * 按命名规范直接归档的文件也要入库（否则时间线和复核看不见它们），但它们的 facts
   * 是从文件名兜底造出来的。界面必须能把两者分开：前者是"系统读到了什么"，后者只是
   * 一个占位。缺省值靠 hasExtractedFacts 从事实本身推，兼容这个字段出现之前的条目。
   */
  factsExtracted?: boolean;
  updatedAt: number;
}

/**
 * 这条记录背后有没有真正抽取过事实。
 *
 * 显式标记优先；历史条目没有标记，就回退到"自报只读到文件名且确实没有任何原文事实"。
 * 单看 sourceQuality 不够——模型经常自报 filename_only 却同时给出了日期和摘录。
 */
export function hasExtractedFacts(
  document: Pick<MinimalDocument, 'facts' | 'factsExtracted'>
): boolean {
  if (typeof document.factsExtracted === 'boolean') return document.factsExtracted;
  return (
    document.facts.sourceQuality !== 'filename_only' ||
    hasContentEvidence(document.facts)
  );
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
        stageSource:
          record.stageSource === 'naming_rule' || record.stageSource === 'human'
            ? record.stageSource
            : undefined,
        archivedFileId:
          typeof record.archivedFileId === 'string'
            ? record.archivedFileId
            : undefined,
        fingerprint:
          typeof record.fingerprint === 'string' ? record.fingerprint : undefined,
        factsExtracted:
          typeof record.factsExtracted === 'boolean'
            ? record.factsExtracted
            : undefined,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      });
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      projectId,
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      documents: mergeDuplicateDocuments(documents),
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
 * 修掉历史数据里已经分裂出来的重复条目。
 *
 * 复核入口早先按纯文件名写，同一份文件因此在库里留下两条（一条带目录路径、一条只有
 * 文件名），份数虚高、旧事实还在参与判断。上面的 findMinimalDocument 只能防住新写入，
 * 已经存在的两条得在读的时候合掉。
 *
 * **只合并"一条带目录、一条不带"这一种情况。** 两条都带目录说明它们本来就在不同
 * 文件夹下，是两份同名文件（客户档案里同名的章程、决议很常见），合并会直接丢数据。
 * 保留读过内容的那一条；都读过就保留更新的那一条。
 */
function mergeDuplicateDocuments(
  documents: MinimalDocument[]
): MinimalDocument[] {
  const byLeaf = new Map<string, MinimalDocument[]>();
  for (const document of documents) {
    const leaf = leafName(document.sourcePath);
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), document]);
  }

  const dropped = new Set<MinimalDocument>();
  for (const [leaf, group] of byLeaf) {
    if (group.length < 2) continue;
    const bare = group.filter(document => document.sourcePath === leaf);
    const withDirectory = group.filter(document => document.sourcePath !== leaf);
    if (bare.length === 0 || withDirectory.length !== 1) continue;

    const survivor = [...group].sort((left, right) => {
      const readDiff =
        Number(hasExtractedFacts(right)) - Number(hasExtractedFacts(left));
      return readDiff !== 0 ? readDiff : right.updatedAt - left.updatedAt;
    })[0];
    for (const document of group) {
      if (document !== survivor) dropped.add(document);
    }
    // 路径统一取带目录的那条，界面和时间线才不会一会儿一个样。
    survivor.sourcePath = withDirectory[0].sourcePath;
  }

  return dropped.size === 0
    ? documents
    : documents.filter(document => !dropped.has(document));
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
  stageSource?: StageSource;
  archivedFileId?: string;
  fingerprint?: string;
  /**
   * 这批事实是不是真读了内容抽出来的。
   * 兜底写入（按文件名归档）必须显式传 false；不给则沿用原有标记，没有原有标记时
   * 从事实本身推断。
   */
  factsExtracted?: boolean;
}

/**
 * 找出这次写入应当覆盖的那一条。
 *
 * **不能只按 sourcePath 精确匹配。** 同一份文件在不同入口拿到的路径粒度不一样：
 * 批量上传用的是目录相对路径（`佰特微档案/投资决策/章程.pdf`），已归档文件右键
 * 「提取事实并复核」手里只有归档记录里的原始文件名（`章程.pdf`）。只按字符串比，
 * 复核一次就凭空多出一条记录——77 份文件复核两份就显示 79 份，旧事实还留在库里
 * 继续参与后续判断，等于同一份文件在系统里有两个互相矛盾的版本。
 *
 * 匹配顺序：归档记录 ID（最硬）→ 完整路径相等 → 文件名唯一命中。
 * 文件名有重名时不敢认，宁可新建一条，也不要把两份同名文件的事实混成一份。
 */
export function findMinimalDocument(
  documents: MinimalDocument[],
  params: { sourcePath: string; archivedFileId?: string }
): MinimalDocument | undefined {
  if (params.archivedFileId) {
    const byId = documents.find(
      document => document.archivedFileId === params.archivedFileId
    );
    if (byId) return byId;
  }
  const byPath = documents.find(
    document => document.sourcePath === params.sourcePath
  );
  if (byPath) return byPath;

  // 只有传进来的本身就是纯文件名（复核入口手里只有归档记录里的名字）才认文件名。
  // 传进来带目录却去认同名的另一条，会把两份不同目录下的同名文件合成一份。
  const leaf = leafName(params.sourcePath);
  if (leaf !== params.sourcePath) return undefined;
  const byLeaf = documents.filter(
    document => leafName(document.sourcePath) === leaf
  );
  return byLeaf.length === 1 ? byLeaf[0] : undefined;
}

export async function upsertMinimalDocument(
  params: UpsertMinimalDocumentParams
): Promise<MinimalProjectArchive> {
  const normalized = params.projectId.trim();
  if (!normalized) throw new Error('写入极简档案需要有效的项目ID');

  return withProjectLock(normalized, async () => {
    const { archive, staleKeys } = await loadFromBackend(normalized);
    const existing = findMinimalDocument(archive.documents, params);
    // 路径粒度取信息更全的那个：复核入口只有文件名，不能让它把目录路径抹掉，
    // 否则时间线里同一份文件时而带目录时而不带，看着像两份。
    const sourcePath =
      existing && leafName(existing.sourcePath) !== existing.sourcePath
        ? existing.sourcePath
        : params.sourcePath;
    const extracted =
      params.factsExtracted ??
      existing?.factsExtracted ??
      hasExtractedFacts({ facts: params.facts });
    // 兜底事实（按文件名归档时造的占位）不许覆盖已经真读出来的事实。
    const keepExistingFacts =
      params.factsExtracted === false &&
      existing !== undefined &&
      hasExtractedFacts(existing);

    const next: MinimalDocument = {
      sourcePath,
      facts: keepExistingFacts ? existing.facts : params.facts,
      // 未显式给出阶段时保留原值，避免重抽事实把用户手动改过的位置冲掉。
      stage: params.stage !== undefined ? params.stage : existing?.stage ?? null,
      // 来源跟着阶段走：给了新阶段就用新来源，没给就保留原来的。
      stageSource:
        params.stage !== undefined
          ? params.stageSource
          : params.stageSource ?? existing?.stageSource,
      archivedFileId: params.archivedFileId ?? existing?.archivedFileId,
      fingerprint: params.fingerprint ?? existing?.fingerprint,
      // 只升不降：读过一次内容之后，后续的兜底写入不能把它打回"没读过"。
      factsExtracted: keepExistingFacts || extracted,
      updatedAt: Date.now(),
    };

    archive.documents = [
      ...archive.documents.filter(document => document !== existing),
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

/**
 * 归档文件被删除时清掉对应的事实。
 *
 * 事实留着不删有实际危害：它仍然会作为"同项目关联文件"参与后续判断，甚至作为
 * 交易锚点为别的文件定方向——用户以为删干净了，实际还在影响结果。
 *
 * 优先按归档记录 ID 匹配；早期条目没有该字段，退回按原始文件名匹配。
 */
export async function forgetMinimalDocumentsByArchivedFile(
  projectId: string,
  params: { archivedFileId?: string; originalName?: string }
): Promise<number> {
  const normalized = projectId.trim();
  if (!normalized) return 0;
  if (!params.archivedFileId && !params.originalName) return 0;

  return withProjectLock(normalized, async () => {
    const { archive, staleKeys } = await loadFromBackend(normalized);
    const remaining = archive.documents.filter(document => {
      if (
        params.archivedFileId &&
        document.archivedFileId === params.archivedFileId
      ) {
        return false;
      }
      if (params.originalName) {
        const leafName =
          document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
        if (leafName === params.originalName) return false;
      }
      return true;
    });

    const removedCount = archive.documents.length - remaining.length;
    if (removedCount > 0) {
      archive.documents = remaining;
      archive.updatedAt = Date.now();
      await saveToBackend(archive, staleKeys);
    }
    return removedCount;
  });
}

/** 清空整个项目的极简事实表。用于重跑测试，或修复历史遗留的孤立条目。 */
export async function clearMinimalArchive(projectId: string): Promise<number> {
  const normalized = projectId.trim();
  if (!normalized) return 0;
  return withProjectLock(normalized, async () => {
    const { archive, staleKeys } = await loadFromBackend(normalized);
    const removedCount = archive.documents.length;
    archive.documents = [];
    archive.dismissedFindings = [];
    archive.updatedAt = Date.now();
    await saveToBackend(archive, staleKeys);
    return removedCount;
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
