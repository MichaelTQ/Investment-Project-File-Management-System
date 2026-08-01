import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  clearAllSessionProjectMemoryForTests,
  clearSessionProjectMemory,
  getSessionProjectMemorySnapshot,
  rememberAndEvaluateProjectDocument,
} from '../src/lib/classification/session-project-memory';

function charterFacts(capital: string): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType: 'company_charter',
    rawDocumentType: '公司章程',
    title: '深圳君柔科技有限公司章程',
    documentNumber: null,
    version: null,
    dates: [],
    parties: [],
    signStatus: 'unknown',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: [`公司注册资本为人民币${capital}万元`],
    warnings: [],
    sourceQuality: 'text',
    extractionConfidence: 90,
  };
}

const preTransactionCharter = charterFacts('11.73624');
const postTransactionCharter = charterFacts('13.04027');

test.beforeEach(() => {
  clearAllSessionProjectMemoryForTests();
});

test('按业务顺序上传时，新章程会触发旧章程重新判断', async () => {
  const first = await rememberAndEvaluateProjectDocument({
    projectId: 'ordered-project',
    sourcePath: '投资决策/公司章程.pdf',
    facts: preTransactionCharter,
  });
  assert.equal(first.currentDecision.status, 'needs_review');
  assert.equal(first.documentCount, 1);

  const second = await rememberAndEvaluateProjectDocument({
    projectId: 'ordered-project',
    sourcePath: '投资实施/项目公司章程.pdf',
    facts: postTransactionCharter,
  });
  assert.equal(second.currentDecision.status, 'decided');
  assert.equal(
    second.currentDecision.decision.selectedCategory?.fileName,
    '项目公司章程'
  );
  assert.equal(second.reEvaluatedDocuments.length, 1);
  assert.deepEqual(
    {
      sourcePath: second.reEvaluatedDocuments[0]?.sourcePath,
      previousStatus: second.reEvaluatedDocuments[0]?.previousStatus,
      status: second.reEvaluatedDocuments[0]?.status,
      previousCategory: second.reEvaluatedDocuments[0]?.previousCategory,
      selectedCategory: second.reEvaluatedDocuments[0]?.selectedCategory,
    },
    {
      sourcePath: '投资决策/公司章程.pdf',
      previousStatus: 'needs_review',
      status: 'decided',
      previousCategory: null,
      selectedCategory: '公司章程',
    }
  );
  assert.equal(
    second.reEvaluatedDocuments[0]?.agentDecision.decision.selectedCategory
      ?.fileName,
    '公司章程'
  );

  const snapshot = getSessionProjectMemorySnapshot('ordered-project');
  assert.equal(snapshot?.documentCount, 2);
  assert.deepEqual(
    snapshot?.documents.map(document => document.selectedCategory).sort(),
    ['公司章程', '项目公司章程']
  );
});

test('乱序上传时，收齐两个版本后仍能恢复正确阶段', async () => {
  const first = await rememberAndEvaluateProjectDocument({
    projectId: 'reverse-project',
    sourcePath: '投资实施/项目公司章程.pdf',
    facts: postTransactionCharter,
  });
  assert.equal(first.currentDecision.status, 'needs_review');

  const second = await rememberAndEvaluateProjectDocument({
    projectId: 'reverse-project',
    sourcePath: '投资决策/公司章程.pdf',
    facts: preTransactionCharter,
  });
  assert.equal(second.currentDecision.status, 'decided');
  assert.equal(
    second.currentDecision.decision.selectedCategory?.fileName,
    '公司章程'
  );
  assert.equal(second.reEvaluatedDocuments.length, 1);
  assert.equal(
    second.reEvaluatedDocuments[0]?.selectedCategory,
    '项目公司章程'
  );
});

test('不同项目的文件事实严格隔离', async () => {
  await rememberAndEvaluateProjectDocument({
    projectId: 'project-a',
    sourcePath: '公司章程.pdf',
    facts: preTransactionCharter,
  });
  const projectB = await rememberAndEvaluateProjectDocument({
    projectId: 'project-b',
    sourcePath: '项目公司章程.pdf',
    facts: postTransactionCharter,
  });

  assert.equal(projectB.currentDecision.status, 'needs_review');
  assert.equal(projectB.relatedDocumentCount, 0);
  assert.equal(getSessionProjectMemorySnapshot('project-a')?.documentCount, 1);
  assert.equal(getSessionProjectMemorySnapshot('project-b')?.documentCount, 1);
});

test('同路径重复上传会幂等更新，删除项目时可完整清理', async () => {
  await rememberAndEvaluateProjectDocument({
    projectId: 'replace-project',
    sourcePath: '历史\\公司章程.pdf',
    facts: preTransactionCharter,
  });
  const updated = await rememberAndEvaluateProjectDocument({
    projectId: 'replace-project',
    sourcePath: '/历史/公司章程.pdf',
    facts: postTransactionCharter,
  });

  assert.equal(updated.documentCount, 1);
  assert.equal(updated.revision, 2);
  assert.equal(clearSessionProjectMemory('replace-project'), true);
  assert.equal(getSessionProjectMemorySnapshot('replace-project'), null);
});
