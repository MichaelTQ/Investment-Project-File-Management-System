import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  loadDurableProjectMemory,
  setDurableProjectMemoryBackendForTests,
  type DurableProjectMemoryBackend,
} from '../src/lib/classification/durable-project-memory';
import {
  clearAllSessionProjectMemoryForTests,
  clearSessionProjectMemory,
  forgetProjectDocument,
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

class MemoryBackend implements DurableProjectMemoryBackend {
  readonly objects = new Map<string, Buffer>();

  async write(storageKey: string, value: Buffer): Promise<string> {
    this.objects.set(storageKey, Buffer.from(value));
    return storageKey;
  }

  async read(storageKey: string): Promise<Buffer> {
    const value = this.objects.get(storageKey);
    if (!value) throw new Error(`missing object: ${storageKey}`);
    return Buffer.from(value);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix));
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

let durableBackend: MemoryBackend;

test.beforeEach(() => {
  durableBackend = new MemoryBackend();
  setDurableProjectMemoryBackendForTests(durableBackend);
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
  assert.equal(first.mode, 's3-durable-shadow');
  assert.equal(first.persistent, true);

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
  assert.equal(await clearSessionProjectMemory('replace-project'), true);
  assert.equal(getSessionProjectMemorySnapshot('replace-project'), null);
  assert.equal(durableBackend.objects.size, 0);
});

test('清空进程缓存模拟重启后，仍从 S3 恢复项目事实', async () => {
  await rememberAndEvaluateProjectDocument({
    projectId: 'restart-project',
    sourcePath: '投资决策/公司章程.pdf',
    facts: preTransactionCharter,
  });

  clearAllSessionProjectMemoryForTests();
  assert.equal(getSessionProjectMemorySnapshot('restart-project'), null);

  const restored = await rememberAndEvaluateProjectDocument({
    projectId: 'restart-project',
    sourcePath: '投资实施/项目公司章程.pdf',
    facts: postTransactionCharter,
  });
  assert.equal(restored.mode, 's3-durable-shadow');
  assert.equal(restored.persistent, true);
  assert.equal(restored.documentCount, 2);
  assert.equal(restored.reEvaluatedDocuments.length, 1);
  assert.equal(
    restored.reEvaluatedDocuments[0]?.selectedCategory,
    '公司章程'
  );
});

test('明确章程文件名可保守恢复 unknown 类型并展示诊断明细', async () => {
  const unknownCharter: DocumentFacts = {
    ...preTransactionCharter,
    documentType: 'unknown',
    rawDocumentType: '未知',
    title: '公司章程',
    warnings: ['扫描件事实抽取不完整'],
  };
  const result = await rememberAndEvaluateProjectDocument({
    projectId: 'recover-type-project',
    sourcePath: '投资决策/公司章程.pdf',
    facts: unknownCharter,
  });

  assert.equal(result.documents[0]?.documentType, 'company_charter');
  assert.match(
    result.documents[0]?.warnings.join('\n') ?? '',
    /保守恢复/
  );
});

test('单文件 tombstone 在重启后仍阻止已删除事实恢复', async () => {
  await rememberAndEvaluateProjectDocument({
    projectId: 'forget-project',
    sourcePath: '投资决策/公司章程.pdf',
    facts: preTransactionCharter,
  });
  assert.equal(
    await forgetProjectDocument(
      'forget-project',
      '投资决策/公司章程.pdf'
    ),
    true
  );
  const afterDelete = await loadDurableProjectMemory('forget-project');
  assert.equal(afterDelete.documents.size, 0);
  assert.equal(afterDelete.context?.sourceDocumentCount, 0);
  assert.equal(afterDelete.context?.timeline.length, 0);
  clearAllSessionProjectMemoryForTests();

  const result = await rememberAndEvaluateProjectDocument({
    projectId: 'forget-project',
    sourcePath: '投资实施/项目公司章程.pdf',
    facts: postTransactionCharter,
  });
  assert.equal(result.documentCount, 1);
  assert.equal(result.currentDecision.status, 'needs_review');
});

test('非章程文件也会随项目上下文变化被重新判断', async () => {
  const bankReceipt: DocumentFacts = {
    schemaVersion: 1,
    documentType: 'bank_receipt',
    rawDocumentType: '银行电子回单',
    title: '银行电子回单',
    documentNumber: null,
    version: null,
    dates: [],
    parties: [{ name: '深圳君柔科技有限公司', role: '收款方' }],
    signStatus: 'unknown',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: ['支付投资款人民币1000万元'],
    warnings: [],
    sourceQuality: 'text',
    extractionConfidence: 90,
  };
  const exitAgreement: DocumentFacts = {
    ...bankReceipt,
    documentType: 'other',
    rawDocumentType: '退出交易协议',
    title: '退出交易协议',
    evidenceQuotes: ['各方签署股权退出交易协议'],
  };
  let synthesisRound = 0;
  const contextSynthesizerClient = {
    invoke: async () => {
      synthesisRound += 1;
      const isExit = synthesisRound > 1;
      return {
        content: JSON.stringify({
          schemaVersion: 1,
          projectName: '跨类型项目',
          targetCompany: '深圳君柔科技有限公司',
          contextStatus: 'llm_synthesized',
          latestEvidencedStage: isExit
            ? 'exit_execution'
            : 'investment_execution',
          stageConfidence: 'high',
          timeline: [
            {
              date: null,
              eventType: isExit
                ? 'exit_payment_made'
                : 'investment_payment_made',
              stage: isExit ? 'exit_execution' : 'investment_execution',
              title: isExit ? '形成退出付款凭证' : '形成投资付款凭证',
              evidenceFiles: ['银行电子回单.pdf'],
              evidence: isExit ? '退出交易付款' : '支付投资款',
              confidence: 'high',
            },
          ],
          stageHypotheses: [],
          documentRelations: [],
          conflicts: [],
          openQuestions: [],
        }),
      };
    },
  };

  const first = await rememberAndEvaluateProjectDocument({
    projectId: 'generic-re-evaluation-project',
    projectName: '跨类型项目',
    sourcePath: '银行电子回单.pdf',
    facts: bankReceipt,
    contextSynthesizerClient: contextSynthesizerClient as never,
  });
  assert.equal(
    first.currentDecision.decision.selectedCategory?.folderId,
    'investment-implementation'
  );
  assert.equal(first.contextSynthesis.llmCallCount, 1);

  const second = await rememberAndEvaluateProjectDocument({
    projectId: 'generic-re-evaluation-project',
    projectName: '跨类型项目',
    sourcePath: '退出交易协议.pdf',
    facts: exitAgreement,
    contextSynthesizerClient: contextSynthesizerClient as never,
  });
  const reEvaluated = second.reEvaluatedDocuments.find(
    document => document.sourcePath === '银行电子回单.pdf'
  );
  assert.equal(reEvaluated?.agentDecision.decision.selectedCategory?.folderId, 'exit-implementation');
});

test('S3 不可用时降级为有明确告警的进程内记忆', async () => {
  setDurableProjectMemoryBackendForTests({
    write: async () => {
      throw new Error('storage unavailable');
    },
    read: async () => {
      throw new Error('storage unavailable');
    },
    list: async () => {
      throw new Error('storage unavailable');
    },
    deletePrefix: async () => {
      throw new Error('storage unavailable');
    },
  });

  const result = await rememberAndEvaluateProjectDocument({
    projectId: 'fallback-project',
    sourcePath: '公司章程.pdf',
    facts: preTransactionCharter,
  });
  assert.equal(result.mode, 'process-local-fallback');
  assert.equal(result.persistent, false);
  assert.match(result.persistenceWarning ?? '', /storage unavailable/);
  assert.ok(result.expiresAt);
  assert.equal(result.currentDecision.status, 'needs_review');
});
