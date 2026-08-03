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

test('目标公司股东会批准增资和章程修改时归入投资实施', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资实施/7君柔科技-股东会决议.pdf',
    facts: facts({
      documentType: 'shareholder_resolution',
      rawDocumentType: '股东会决议',
      title: '深圳君柔科技有限公司股东会决议',
      evidenceQuotes: [
        '同意公司注册资本由11.73624万元增加至13.04027万元',
        '同意签署《增资协议》并相应修改公司章程',
      ],
    }),
    projectContext,
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.selectedCategory?.fileName, '股东会决议');
  assert.equal(decision.requiresHumanReview, false);
  assert.match(decision.policyVersion, /shareholder-resolution-v1/);
});

test('投委会决议不能被股东会规则误收，并在投决阶段安全兜底', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资决策/基金投委会决议.pdf',
    facts: facts({
      documentType: 'shareholder_resolution',
      rawDocumentType: '决议',
      title: '基金投资决策委员会决议',
      evidenceQuotes: ['基金投委会决议通过投资君柔项目'],
    }),
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.businessStage, 'investment_decision');
  assert.equal(decision.selectedCategory?.folderId, 'investment-decision');
  assert.equal(decision.selectedCategory?.fileName, '其他投资决策材料');
  assert.equal(decision.routingMethod, 'safe_stage_fallback');
  assert.equal(decision.requiresHumanReview, true);
  assert.ok(decision.contradictions.some(item => item.includes('投委会')));
});

test('交割确认函根据交割条件和项目事件归入确权文件', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资实施/5中山致远望睿交割确认函.pdf',
    facts: facts({
      documentType: 'closing_confirmation',
      rawDocumentType: '交割确认函',
      title: '附件1 交割确认函',
      explicitStageClues: [
        '根据增资协议确认各项交割先决条件均已满足',
      ],
    }),
    projectContext,
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.selectedCategory?.fileName, '确权文件');
  assert.equal(decision.requiresHumanReview, false);
  assert.match(decision.policyVersion, /closing-confirmation-v1/);
});

test('缴款通知书根据支付要求和交易文件归入付款通知函', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资实施/8中山致远望睿缴款通知书.pdf',
    facts: facts({
      documentType: 'payment_notice',
      rawDocumentType: '缴款通知书',
      title: '中山致远望睿缴款通知书',
      explicitStageClues: [
        '根据《增资协议》《加入协议》，以电汇方式支付增资款至公司指定账户',
      ],
    }),
    projectContext,
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.selectedCategory?.fileName, '付款通知函');
  assert.equal(decision.requiresHumanReview, false);
  assert.match(decision.policyVersion, /payment-notice-v1/);
});

test('银行回单不能被付款通知规则误收', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资实施/电子回单.png',
    facts: facts({
      documentType: 'payment_notice',
      rawDocumentType: '银行电子回单',
      title: '银行电子回单',
      evidenceQuotes: ['交易成功，银行电子回单，附言投资款'],
    }),
  });

  assert.equal(decision.status, 'insufficient');
  assert.equal(decision.selectedCategory, null);
  assert.ok(decision.contradictions.some(item => item.includes('银行回单')));
});

test('立项表决结果在缺少细分类时安全归入项目立项阶段', () => {
  const decision = decideWithProjectContext({
    sourcePath: '佰特微立项表决结果.pdf',
    facts: facts({
      documentType: 'voting_result',
      rawDocumentType: '立项表决结果',
      title: '佰特微医疗B轮融资项目立项表决结果',
      explicitStageClues: ['立项会委员对项目立项进行表决'],
      evidenceQuotes: [
        '表决结果：3票同意，0票不同意',
        '本项目通过立项',
      ],
    }),
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.businessStage, 'initiation');
  assert.equal(decision.selectedCategory?.folderId, 'project-initiation');
  assert.equal(decision.selectedCategory?.fileName, '其他立项材料');
  assert.equal(decision.routingMethod, 'safe_stage_fallback');
  assert.equal(decision.requiresHumanReview, true);
});

test('真正的投委会表决票仍归入投资决策', () => {
  const decision = decideWithProjectContext({
    sourcePath: '投资决策/基金投委会表决票.pdf',
    facts: facts({
      documentType: 'voting_result',
      rawDocumentType: '投委会表决票',
      title: '基金投资决策委员会项目表决票',
      evidenceQuotes: ['投资决策委员会委员同意本项目投资方案'],
    }),
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.businessStage, 'investment_decision');
  assert.equal(decision.selectedCategory?.folderId, 'decision-documents');
  assert.equal(decision.selectedCategory?.fileName, '表决票');
  assert.notEqual(decision.routingMethod, 'safe_stage_fallback');
});

test('退出表决票仍归入退出决策', () => {
  const decision = decideWithProjectContext({
    sourcePath: '项目退出/退出表决票.pdf',
    facts: facts({
      documentType: 'voting_result',
      rawDocumentType: '退出表决票',
      title: '项目退出表决票',
      evidenceQuotes: ['委员同意退出方案'],
    }),
  });

  assert.equal(decision.status, 'decided');
  assert.equal(decision.businessStage, 'exit_decision');
  assert.equal(decision.selectedCategory?.folderId, 'exit-decision-docs');
  assert.equal(decision.selectedCategory?.fileName, '退出表决票');
});

test('无法判断阶段的表决结果不会猜测其他阶段目录', () => {
  const decision = decideWithProjectContext({
    sourcePath: '项目表决结果.pdf',
    facts: facts({
      documentType: 'voting_result',
      rawDocumentType: '表决结果',
      title: '项目表决结果',
      evidenceQuotes: ['三票同意，零票反对'],
    }),
  });

  assert.equal(decision.status, 'insufficient');
  assert.equal(decision.businessStage, null);
  assert.equal(decision.selectedCategory, null);
  assert.equal(decision.routingMethod, 'needs_stage_review');
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
