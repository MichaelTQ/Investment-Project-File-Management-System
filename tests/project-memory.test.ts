import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  buildDocumentFactRow,
  createClassificationDecisionRecord,
  createDocumentFingerprint,
  upsertDocumentFactsRecord,
} from '../src/lib/project-memory';

const facts: DocumentFacts = {
  schemaVersion: 1,
  documentType: 'company_charter',
  rawDocumentType: '公司章程',
  title: '深圳君柔科技有限公司章程',
  documentNumber: null,
  version: '修订版',
  dates: [],
  parties: [{ name: '深圳君柔科技有限公司', role: '项目公司' }],
  signStatus: 'sealed',
  transactionChanges: [
    {
      field: '注册资本',
      before: '11.73624万元',
      after: '13.04027万元',
      evidence: '注册资本增加至人民币13.04027万元',
    },
  ],
  explicitStageClues: ['修改公司章程'],
  evidenceQuotes: ['注册资本总额为人民币13.04027万元'],
  warnings: [],
  sourceQuality: 'visual_summary',
  extractionConfidence: 92,
};

function baseParams() {
  return {
    projectId: 'project-1',
    originalName: '公司章程.pdf',
    fileSize: 123,
    mimeType: 'application/pdf',
    facts,
    extractionStatus: 'success' as const,
    extractorVersion: 'document-facts-v1',
    modelVersion: 'test-model',
  };
}

test('内容指纹对同一文件稳定，并优先于存储地址', () => {
  const first = createDocumentFingerprint({
    fileBuffer: Buffer.from('same content'),
    storageKey: 'uploads/one',
    originalName: 'a.pdf',
    fileSize: 12,
    mimeType: 'application/pdf',
  });
  const second = createDocumentFingerprint({
    fileBuffer: Buffer.from('same content'),
    storageKey: 'uploads/two',
    originalName: 'renamed.pdf',
    fileSize: 12,
    mimeType: 'application/pdf',
  });

  assert.equal(first.kind, 'content_sha256');
  assert.equal(first.value, second.value);
});

test('没有文件 Buffer 时使用稳定的存储身份指纹', () => {
  const first = createDocumentFingerprint({
    storageKey: 'uploads/project/file.pdf',
    originalName: 'file.pdf',
    fileSize: 99,
    mimeType: 'application/pdf',
  });
  const second = createDocumentFingerprint({
    storageKey: 'uploads/project/file.pdf',
    originalName: 'file.pdf',
    fileSize: 99,
    mimeType: 'application/pdf',
  });

  assert.equal(first.kind, 'storage_identity');
  assert.equal(first.value, second.value);
  assert.equal(first.value.length, 64);
});

test('文档事实行同时保存可查询列和完整事实载荷', () => {
  const row = buildDocumentFactRow({
    ...baseParams(),
    fileBuffer: Buffer.from('charter'),
  });

  assert.equal(row.document_type, 'company_charter');
  assert.equal(row.fingerprint_kind, 'content_sha256');
  assert.equal(row.extraction_confidence, 92);
  assert.deepEqual(row.transaction_changes, facts.transactionChanges);
  assert.deepEqual(row.facts_payload, facts);
});

test('文档事实 upsert 使用项目与源指纹作为幂等键', async () => {
  let capturedConflict = '';
  let capturedRow: Record<string, unknown> | undefined;
  const fakeClient = {
    from(table: string) {
      assert.equal(table, 'document_facts');
      return {
        upsert(row: Record<string, unknown>, options: { onConflict: string }) {
          capturedRow = row;
          capturedConflict = options.onConflict;
          return {
            select() {
              return {
                async single() {
                  return {
                    data: {
                      id: 'fact-1',
                      project_id: 'project-1',
                      archived_file_id: null,
                      source_fingerprint: row.source_fingerprint,
                      document_type: row.document_type,
                      extraction_status: row.extraction_status,
                      extraction_confidence: row.extraction_confidence,
                      created_at: '2026-08-01T00:00:00Z',
                      updated_at: '2026-08-01T00:00:00Z',
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const result = await upsertDocumentFactsRecord(baseParams(), fakeClient);

  assert.equal(capturedConflict, 'project_id,source_fingerprint');
  assert.equal(capturedRow?.document_type, 'company_charter');
  assert.equal(result.id, 'fact-1');
});

test('legacy shadow 分类决策保存策略版本和复核状态', async () => {
  let capturedRow: Record<string, unknown> | undefined;
  const fakeClient = {
    from(table: string) {
      assert.equal(table, 'classification_decisions');
      return {
        insert(row: Record<string, unknown>) {
          capturedRow = row;
          return {
            select(selection: string) {
              assert.equal(selection, 'id');
              return {
                async single() {
                  return { data: { id: 'decision-1' }, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const id = await createClassificationDecisionRecord(
    {
      projectId: 'project-1',
      documentFactId: 'fact-1',
      selectedCategoryId: 'investment-implementation',
      selectedCategoryName: '项目公司章程',
      selectedFolderPath: ['投资项目档案', '投资实施'],
      candidateCategories: [],
      evidence: ['注册资本发生变化'],
      contradictions: [],
      decisionScore: 82,
      decisionSource: 'llm',
      reasoning: '测试',
      modelVersion: 'test-model',
      policyVersion: 'legacy-classification-v1',
      requiresReview: true,
    },
    fakeClient
  );

  assert.equal(id, 'decision-1');
  assert.equal(capturedRow?.policy_version, 'legacy-classification-v1');
  assert.equal(capturedRow?.review_status, 'pending');
  assert.equal(capturedRow?.document_fact_id, 'fact-1');
});

test('SQL 迁移包含四张项目记忆表和必要唯一约束', () => {
  const sql = readFileSync(
    'src/storage/database/migrations/0001_agent_context.sql',
    'utf8'
  );

  for (const table of [
    'project_contexts',
    'project_events',
    'document_facts',
    'classification_decisions',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`));
  }
  assert.match(sql, /unique\(project_id, source_fingerprint\)/);
  assert.match(sql, /check \(extraction_confidence between 0 and 100\)/);
});
