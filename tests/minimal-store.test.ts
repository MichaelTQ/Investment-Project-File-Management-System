import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  hasExtractedFacts,
  loadMinimalArchive,
  setMinimalArchiveBackendForTests,
  upsertMinimalDocument,
} from '../src/lib/classification/minimal/store';

/**
 * 事实表的写入语义。
 *
 * 这里守的是一条从界面上看不出来的错：同一份文件被写成两条记录。批量上传写的是目录
 * 相对路径，已归档文件右键复核写的是纯文件名，只按字符串比对就会各存一份——份数虚高，
 * 旧事实还留在库里继续参与后续判断。
 */

const PROJECT_ID = 'project-store-test';

function memoryBackend() {
  const store = new Map<string, Buffer>();
  return {
    store,
    write: async (storageKey: string, value: Buffer) => {
      store.set(storageKey, value);
      return storageKey;
    },
    read: async (storageKey: string) => {
      const value = store.get(storageKey);
      if (!value) throw new Error(`not found: ${storageKey}`);
      return value;
    },
    list: async (prefix: string) =>
      [...store.keys()].filter(key => key.startsWith(prefix)),
    delete: async (storageKey: string) => {
      store.delete(storageKey);
    },
  };
}

function facts(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType: 'company_charter',
    rawDocumentType: '公司章程',
    title: '公司章程',
    documentNumber: null,
    version: null,
    dates: [],
    parties: [],
    signStatus: 'sealed',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: [],
    warnings: [],
    sourceQuality: 'text',
    extractionConfidence: 90,
    ...overrides,
  };
}

const filenameOnlyFacts = facts({
  sourceQuality: 'filename_only',
  signStatus: 'unknown',
  extractionConfidence: 10,
});

afterEach(() => {
  setMinimalArchiveBackendForTests(null);
});

test('复核只带文件名时覆盖原有条目，不新增一条', async () => {
  setMinimalArchiveBackendForTests(memoryBackend());

  await upsertMinimalDocument({
    projectId: PROJECT_ID,
    sourcePath: '佰特微档案/投资决策/章程2024.11.pdf',
    facts: filenameOnlyFacts,
    factsExtracted: false,
    stage: 'investment_decision',
  });
  await upsertMinimalDocument({
    projectId: PROJECT_ID,
    sourcePath: '章程2024.11.pdf',
    facts: facts({ evidenceQuotes: ['股东应于2024年11月30日前缴足'] }),
    factsExtracted: true,
  });

  const archive = await loadMinimalArchive(PROJECT_ID);
  assert.equal(archive.documents.length, 1);
  const [stored] = archive.documents;
  // 路径取信息更全的那个，时间线里不会一会儿带目录一会儿不带。
  assert.equal(stored.sourcePath, '佰特微档案/投资决策/章程2024.11.pdf');
  // 新事实覆盖旧事实。
  assert.deepEqual(stored.facts.evidenceQuotes, ['股东应于2024年11月30日前缴足']);
  assert.equal(hasExtractedFacts(stored), true);
  // 没显式给阶段就保留原来的，读内容不会把人工确认过的位置冲掉。
  assert.equal(stored.stage, 'investment_decision');
});

test('同名但都带目录的两份文件各存各的', async () => {
  setMinimalArchiveBackendForTests(memoryBackend());

  await upsertMinimalDocument({
    projectId: PROJECT_ID,
    sourcePath: '投资决策/公司章程.pdf',
    facts: facts(),
  });
  await upsertMinimalDocument({
    projectId: PROJECT_ID,
    sourcePath: '投资实施/公司章程.pdf',
    facts: facts(),
  });

  const archive = await loadMinimalArchive(PROJECT_ID);
  assert.equal(archive.documents.length, 2);
});

test('按文件名归档的兜底写入不会覆盖已经读出来的事实', async () => {
  setMinimalArchiveBackendForTests(memoryBackend());

  await upsertMinimalDocument({
    projectId: PROJECT_ID,
    sourcePath: '章程.pdf',
    facts: facts({ evidenceQuotes: ['注册资本 11.73624 万元'] }),
    factsExtracted: true,
  });
  await upsertMinimalDocument({
    projectId: PROJECT_ID,
    sourcePath: '章程.pdf',
    facts: filenameOnlyFacts,
    factsExtracted: false,
    stage: 'investment_execution',
  });

  const archive = await loadMinimalArchive(PROJECT_ID);
  assert.equal(archive.documents.length, 1);
  assert.deepEqual(archive.documents[0].facts.evidenceQuotes, [
    '注册资本 11.73624 万元',
  ]);
  assert.equal(hasExtractedFacts(archive.documents[0]), true);
  assert.equal(archive.documents[0].stage, 'investment_execution');
});

test('历史数据里已经分裂的重复条目在读取时合掉', async () => {
  const backend = memoryBackend();
  setMinimalArchiveBackendForTests(backend);

  const projectHash = (await import('node:crypto'))
    .createHash('sha256')
    .update(PROJECT_ID)
    .digest('hex');
  backend.store.set(
    `minimal-archive/v1/projects/${projectHash}/archive.json`,
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        projectId: PROJECT_ID,
        updatedAt: 3,
        dismissedFindings: [],
        documents: [
          {
            sourcePath: '佰特微档案/投资决策/章程2024.11.pdf',
            facts: filenameOnlyFacts,
            stage: 'investment_decision',
            updatedAt: 1,
          },
          {
            sourcePath: '章程2024.11.pdf',
            facts: facts({ evidenceQuotes: ['注册资本 100 万元'] }),
            stage: null,
            updatedAt: 2,
          },
        ],
      }),
      'utf8'
    )
  );

  const archive = await loadMinimalArchive(PROJECT_ID);
  assert.equal(archive.documents.length, 1);
  assert.equal(
    archive.documents[0].sourcePath,
    '佰特微档案/投资决策/章程2024.11.pdf'
  );
  // 读过内容的那一条留下来。
  assert.deepEqual(archive.documents[0].facts.evidenceQuotes, [
    '注册资本 100 万元',
  ]);
});
