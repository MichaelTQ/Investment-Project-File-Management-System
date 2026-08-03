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
  commitArchivedProjectDocument,
  evaluateProjectDocumentCandidate,
  forgetProjectDocument,
  forgetProjectDocumentByArchivedFileId,
  getProjectContextMemoryView,
  getSessionProjectMemorySnapshot,
  rebuildProjectContext,
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
  readKeys: string[] = [];
  listPrefixes: string[] = [];

  async write(storageKey: string, value: Buffer): Promise<string> {
    this.objects.set(storageKey, Buffer.from(value));
    return storageKey;
  }

  async read(storageKey: string): Promise<Buffer> {
    this.readKeys.push(storageKey);
    const value = this.objects.get(storageKey);
    if (!value) throw new Error(`missing object: ${storageKey}`);
    return Buffer.from(value);
  }

  async list(prefix: string): Promise<string[]> {
    this.listPrefixes.push(prefix);
    return [...this.objects.keys()].filter(key => key.startsWith(prefix));
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }

  resetMetrics(): void {
    this.readKeys = [];
    this.listPrefixes = [];
  }
}

class RandomizingKeyMemoryBackend extends MemoryBackend {
  private sequence = 0;

  override async write(storageKey: string, value: Buffer): Promise<string> {
    this.sequence += 1;
    const actualKey = storageKey.replace(
      /\.json$/,
      `_${String(this.sequence).padStart(4, '0')}.json`
    );
    this.objects.set(actualKey, Buffer.from(value));
    return actualKey;
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
    second.currentDecision.decision.selectedFolder?.name,
    '投资实施'
  );
  assert.equal(second.reEvaluatedDocuments.length, 1);
  assert.deepEqual(
    {
      sourcePath: second.reEvaluatedDocuments[0]?.sourcePath,
      previousStatus: second.reEvaluatedDocuments[0]?.previousStatus,
      status: second.reEvaluatedDocuments[0]?.status,
      previousFolder: second.reEvaluatedDocuments[0]?.previousFolder,
      selectedFolder: second.reEvaluatedDocuments[0]?.selectedFolder,
    },
    {
      sourcePath: '投资决策/公司章程.pdf',
      previousStatus: 'needs_review',
      status: 'decided',
      previousFolder: null,
      selectedFolder: '投资决策',
    }
  );
  assert.equal(
    second.reEvaluatedDocuments[0]?.agentDecision.decision.selectedFolder
      ?.name,
    '投资决策'
  );

  const snapshot = getSessionProjectMemorySnapshot('ordered-project');
  assert.equal(snapshot?.documentCount, 2);
  assert.deepEqual(
    snapshot?.documents.map(document => document.selectedFolder).sort(),
    ['投资决策', '投资实施']
  );
});

test('候选文件先使用已提交Context判断，归档提交后才进入正式记忆', async () => {
  const evaluated = await evaluateProjectDocumentCandidate({
    projectId: 'commit-boundary-project',
    projectName: '提交边界项目',
    sourcePath: '公司章程.pdf',
    facts: preTransactionCharter,
  });
  assert.equal(evaluated.documentCount, 0);
  assert.equal(evaluated.decisionContextVersion, 0);
  assert.equal(
    (await loadDurableProjectMemory('commit-boundary-project')).documents.size,
    0
  );

  const committed = await commitArchivedProjectDocument({
    projectId: 'commit-boundary-project',
    projectName: '提交边界项目',
    sourcePath: '公司章程.pdf',
    facts: preTransactionCharter,
    archivedFileId: 'archived-charter-1',
  });
  assert.equal(committed.documentCount, 1);
  assert.equal(committed.contextState.status, 'clean');
  assert.equal(committed.contextState.version, 1);
  assert.equal(
    [...durableBackend.objects.keys()].filter(key => key.endsWith('/snapshot.json'))
      .length,
    1
  );
  assert.equal(
    [...durableBackend.objects.keys()].filter(
      key => key.includes('/documents/') || key.includes('/contexts/')
    ).length,
    0
  );
});

test('进程内缓存版本未变化时只读取轻量 revision，不重复下载项目快照', async () => {
  await commitArchivedProjectDocument({
    projectId: 'warm-cache-project',
    projectName: '缓存项目',
    sourcePath: '公司章程.pdf',
    facts: preTransactionCharter,
    archivedFileId: 'warm-cache-file-1',
  });
  durableBackend.resetMetrics();

  const view = await getProjectContextMemoryView('warm-cache-project');

  assert.equal(view.documentCount, 1);
  assert.equal(durableBackend.listPrefixes.length, 1);
  assert.match(durableBackend.listPrefixes[0] ?? '', /\/revision$/);
  assert.equal(durableBackend.readKeys.length, 1);
  assert.match(durableBackend.readKeys[0] ?? '', /\/revision\.json$/);
});

test('Coze 自动改写上传 key 时仍使用真实 key 校验并压缩旧快照', async () => {
  const randomizingBackend = new RandomizingKeyMemoryBackend();
  durableBackend = randomizingBackend;
  setDurableProjectMemoryBackendForTests(randomizingBackend);

  const first = await commitArchivedProjectDocument({
    projectId: 'random-key-project',
    projectName: '随机Key项目',
    sourcePath: '立项申请.pdf',
    facts: preTransactionCharter,
    archivedFileId: 'random-key-file-1',
  });
  const second = await rebuildProjectContext('random-key-project');

  assert.equal(first.persistent, true);
  assert.equal(second.persistent, true);
  assert.equal(second.persistenceWarning, undefined);
  assert.equal(
    [...randomizingBackend.objects.keys()].filter(key =>
      /\/snapshot_\d+\.json$/.test(key)
    ).length,
    1
  );
  assert.equal(
    [...randomizingBackend.objects.keys()].filter(key =>
      /\/revision_\d+\.json$/.test(key)
    ).length,
    1
  );

  clearAllSessionProjectMemoryForTests();
  const restored = await getProjectContextMemoryView('random-key-project');
  assert.equal(restored.persistent, true);
  assert.equal(restored.documentCount, 1);
});

test('删除只标记Context过期，下次候选判断前自动重建', async () => {
  let llmCalls = 0;
  const contextSynthesizerClient = {
    invoke: async () => {
      llmCalls += 1;
      return {
        content: JSON.stringify({
          schemaVersion: 1,
          projectName: '延迟重建项目',
          targetCompany: null,
          contextStatus: 'llm_synthesized',
          latestEvidencedStage: 'unknown',
          stageConfidence: 'low',
          timeline: [],
          stageHypotheses: [],
          documentRelations: [],
          conflicts: [],
          openQuestions: [],
        }),
      };
    },
  };
  await commitArchivedProjectDocument({
    projectId: 'deferred-rebuild-project',
    projectName: '延迟重建项目',
    sourcePath: '公司章程.pdf',
    facts: preTransactionCharter,
    archivedFileId: 'archived-delete-1',
    contextSynthesizerClient: contextSynthesizerClient as never,
  });
  assert.equal(llmCalls, 1);
  await commitArchivedProjectDocument({
    projectId: 'deferred-rebuild-project',
    projectName: '延迟重建项目',
    sourcePath: '保留文件.pdf',
    facts: postTransactionCharter,
    archivedFileId: 'archived-keep-1',
    contextSynthesizerClient: contextSynthesizerClient as never,
  });
  assert.equal(llmCalls, 2);

  await forgetProjectDocumentByArchivedFileId(
    'deferred-rebuild-project',
    'archived-delete-1'
  );
  const dirty = await getProjectContextMemoryView('deferred-rebuild-project');
  assert.equal(dirty.contextState.status, 'dirty');
  assert.equal(llmCalls, 2);

  const nextCandidate = await evaluateProjectDocumentCandidate({
    projectId: 'deferred-rebuild-project',
    projectName: '延迟重建项目',
    sourcePath: '下一份文件.pdf',
    facts: postTransactionCharter,
    contextSynthesizerClient: contextSynthesizerClient as never,
  });
  assert.equal(llmCalls, 3);
  assert.equal(nextCandidate.contextState.status, 'clean');
  assert.equal(nextCandidate.documentCount, 1);
  assert.equal(nextCandidate.decisionContextVersion, 3);
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
    second.currentDecision.decision.selectedFolder?.name,
    '投资决策'
  );
  assert.equal(second.reEvaluatedDocuments.length, 1);
  assert.equal(
    second.reEvaluatedDocuments[0]?.selectedFolder,
    '投资实施'
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
  assert.equal(updated.contextState.version, 2);
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
    restored.reEvaluatedDocuments[0]?.selectedFolder,
    '投资决策'
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

test('单文件从快照删除后在重启后不会恢复', async () => {
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
  assert.equal(afterDelete.contextState.status, 'dirty');
  assert.equal(afterDelete.context?.sourceDocumentCount, 1);
  const rebuilt = await rebuildProjectContext('forget-project');
  assert.equal(rebuilt.contextState.status, 'clean');
  assert.equal(rebuilt.projectContext?.sourceDocumentCount, 0);
  assert.equal(rebuilt.projectContext?.timeline.length, 0);
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
    first.currentDecision.decision.selectedFolder?.folderId,
    'investment-implementation'
  );
  assert.equal(first.contextSynthesis?.llmCallCount, 1);

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
  assert.equal(reEvaluated?.agentDecision.decision.selectedFolder?.folderId, 'exit-implementation');
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
    delete: async () => {
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
