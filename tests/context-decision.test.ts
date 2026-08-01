import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  decideWithProjectContext,
  parseProjectContextSnapshot,
  parseRelatedDocumentFacts,
  type ProjectContextSnapshot,
} from '../src/lib/classification/context-decision';
import type { DocumentFacts } from '../src/lib/classification/document-facts';

const projectContext = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/junrou-project-context.json'),
    'utf8'
  )
) as ProjectContextSnapshot;

function facts(
  overrides: Partial<DocumentFacts> &
    Pick<DocumentFacts, 'documentType' | 'rawDocumentType' | 'title'>
): DocumentFacts {
  return {
    schemaVersion: 1,
    documentNumber: null,
    version: null,
    dates: [],
    parties: [],
    signStatus: 'unknown',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: [],
    warnings: [],
    sourceQuality: 'text',
    extractionConfidence: 90,
    ...overrides,
  };
}

const preTransactionCharter = facts({
  documentType: 'company_charter',
  rawDocumentType: '公司章程',
  title: '深圳君柔科技有限公司章程',
  evidenceQuotes: ['公司注册资本为人民币11.73624万元'],
});

const postTransactionCharter = facts({
  documentType: 'company_charter',
  rawDocumentType: '公司章程',
  title: '深圳君柔科技有限公司章程（修订版）',
  dates: [
    {
      date: '2026-04-10',
      meaning: '股东会批准修订日期',
      evidence: '2026年4月10日股东会通过',
    },
  ],
  transactionChanges: [
    {
      field: '注册资本',
      before: '11.73624万元',
      after: '13.04027万元',
      evidence: '注册资本由11.73624万元增加至13.04027万元',
    },
    {
      field: '股东结构',
      before: '原股东',
      after: '新增三名投资方',
      evidence: '新增股东并修改公司章程',
    },
  ],
  explicitStageClues: ['股东会批准本次增资并修改公司章程'],
  evidenceQuotes: ['注册资本总额为人民币13.04027万元'],
});

test('关联章程的注册资本差异可识别交易前章程', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资决策/公司章程.pdf',
    facts: preTransactionCharter,
    projectContext,
    relatedDocuments: [
      {
        sourcePath: '投资实施/6君柔科技-公司章程.pdf',
        facts: postTransactionCharter,
      },
    ],
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.selectedCategory?.folderId, 'decision-meeting');
  assert.equal(decision.selectedCategory?.fileName, '公司章程');
  assert.equal(decision.requiresHumanReview, false);
  assert.ok(decision.evidence.some(item => item.includes('注册资本更高')));
});

test('增资变化和关联低资本章程可识别投资实施章程', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资实施/6君柔科技-公司章程.pdf',
    facts: postTransactionCharter,
    projectContext,
    relatedDocuments: [
      {
        sourcePath: '投资决策/公司章程.pdf',
        facts: preTransactionCharter,
      },
    ],
  });

  assert.equal(decision.status, 'decided');
  assert.equal(
    decision.selectedCategory?.folderId,
    'investment-implementation'
  );
  assert.equal(decision.selectedCategory?.fileName, '项目公司章程');
  assert.ok(decision.confidence >= 90);
  assert.ok(decision.evidence.some(item => item.includes('结构化事实')));
});

test('项目当前处于投资实施不能单独决定历史章程位置', () => {
  const decision = decideWithProjectContext({
    sourcePath: '未知/公司章程.pdf',
    facts: preTransactionCharter,
    projectContext,
  });

  assert.equal(decision.status, 'insufficient');
  assert.equal(decision.selectedCategory, null);
  assert.equal(decision.requiresHumanReview, true);
});

test('投资合规性审查表有充分证据仍默认人工复核', () => {
  const decision = decideWithProjectContext({
    sourcePath: '中山火炬电子产业基金管理有限公司-君柔科技.pdf',
    facts: facts({
      documentType: 'investment_compliance_review',
      rawDocumentType: '投资项目合规性审查表',
      title: '君柔科技投资项目合规性审查表',
      explicitStageClues: ['子基金管理人意见'],
      evidenceQuotes: ['本项目不违反基金投资限制和禁止事项'],
    }),
    projectContext,
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.selectedCategory?.fileName, '投资合规性审查表');
  assert.equal(decision.requiresHumanReview, true);
  assert.match(decision.policyVersion, /investment-compliance-review-v1/);
});

test('一般性合规表述不足以形成上下文决策', () => {
  const decision = decideWithProjectContext({
    sourcePath: '合规说明.pdf',
    facts: facts({
      documentType: 'investment_compliance_review',
      rawDocumentType: '合规说明',
      title: '公司合规说明',
      evidenceQuotes: ['公司依法合规经营'],
    }),
  });

  assert.equal(decision.status, 'insufficient');
  assert.equal(decision.selectedCategory, null);
  assert.equal(decision.requiresHumanReview, true);
});

test('上下文输入只接受符合 Schema 的项目快照和关联事实', () => {
  assert.equal(parseProjectContextSnapshot(projectContext)?.projectName, '君柔');
  assert.equal(parseProjectContextSnapshot({ projectName: '君柔' }), null);
  assert.equal(
    parseRelatedDocumentFacts([
      { sourcePath: '公司章程.pdf', facts: preTransactionCharter },
    ]).length,
    1
  );
  assert.deepEqual(parseRelatedDocumentFacts([{ invalid: true }]), []);
});
