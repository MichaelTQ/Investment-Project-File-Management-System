import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimeline,
  describeResolvedEvidence,
  resolveEvidence,
} from '../src/lib/classification/minimal/evidence';
import type { MinimalDocument } from '../src/lib/classification/minimal/store';
import type { DocumentFacts } from '../src/lib/classification/document-facts';

function facts(
  overrides: Partial<DocumentFacts> &
    Pick<DocumentFacts, 'documentType' | 'title'>
): DocumentFacts {
  return {
    schemaVersion: 1,
    rawDocumentType: overrides.title,
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

function document(
  sourcePath: string,
  stage: MinimalDocument['stage'],
  documentFacts: DocumentFacts
): MinimalDocument {
  return { sourcePath, stage, facts: documentFacts, updatedAt: 0 };
}

const preCharter = document(
  '公司章程.pdf',
  'investment_decision',
  facts({
    documentType: 'company_charter',
    title: '公司章程',
    dates: [{ date: '2026-03-20', meaning: '生效日期', evidence: '章程生效' }],
    evidenceQuotes: ['注册资本为人民币11.73624万元'],
  })
);

const postCharter = document(
  '6君柔科技-公司章程.pdf',
  'investment_execution',
  facts({
    documentType: 'company_charter',
    title: '公司章程',
    dates: [{ date: '2026-04-12', meaning: '修订生效', evidence: '修订章程' }],
    evidenceQuotes: ['注册资本为人民币13.04027万元'],
  })
);

const resolution = document(
  '7君柔科技-股东会决议.pdf',
  'investment_execution',
  facts({
    documentType: 'shareholder_resolution',
    title: '股东会决议',
    dates: [{ date: '2026-04-10', meaning: '批准日期', evidence: '决议形成' }],
    transactionChanges: [
      {
        field: '注册资本',
        before: '11.73624万元',
        after: '13.04027万元',
        evidence: '股东会批准注册资本由11.73624万元增加至13.04027万元',
      },
    ],
  })
);

test('交易锚点在场时定出文件在交易之前，把握为高', () => {
  const resolved = resolveEvidence(preCharter, [postCharter, resolution]);
  assert.equal(resolved.transactionSide?.side, 'before');
  assert.equal(
    resolved.transactionSide?.anchorSourcePath,
    '7君柔科技-股东会决议.pdf'
  );
  assert.equal(resolved.strength, 'high');
  assert.equal(resolved.confidence, 85);
});

test('交易后的版本同样能定出，方向来自交易记录而非金额大小', () => {
  const resolved = resolveEvidence(postCharter, [preCharter, resolution]);
  assert.equal(resolved.transactionSide?.side, 'after');
  assert.equal(resolved.strength, 'high');
});

test('减资场景方向不反：金额更小的是交易之后', () => {
  const reduction = document(
    '减资决议.pdf',
    'post_investment',
    facts({
      documentType: 'shareholder_resolution',
      title: '减资决议',
      evidenceQuotes: ['注册资本由人民币500万元减少至人民币300万元'],
    })
  );
  const charterAfter = document(
    '减资后章程.pdf',
    'post_investment',
    facts({
      documentType: 'company_charter',
      title: '章程',
      evidenceQuotes: ['注册资本为人民币300万元'],
    })
  );
  const resolved = resolveEvidence(charterAfter, [reduction]);
  assert.equal(resolved.transactionSide?.side, 'after');
});

test('没有交易锚点时给出倾向性推测而不是沉默', () => {
  const resolved = resolveEvidence(preCharter, [postCharter]);
  assert.equal(resolved.transactionSide, null);
  assert.equal(resolved.tendency?.side, 'before');
  assert.equal(resolved.tendency?.siblingSourcePath, '6君柔科技-公司章程.pdf');
  assert.deepEqual(resolved.sameTypeSiblings, ['6君柔科技-公司章程.pdf']);
});

test('倾向性推测明确标注为推测，且要求转人工', () => {
  const text = describeResolvedEvidence(resolveEvidence(preCharter, [postCharter]));
  assert.match(text, /倾向性推测，不是证据/);
  assert.match(text, /review 设为 true/);
  assert.match(text, /减资、回购或退出/);
});

test('读不到可比金额时才回到"说清缺什么"', () => {
  const bareCharter = document(
    '无金额章程.pdf',
    null,
    facts({ documentType: 'company_charter', title: '公司章程' })
  );
  const text = describeResolvedEvidence(
    resolveEvidence(bareCharter, [postCharter])
  );
  assert.match(text, /不要凭空猜方向/);
  assert.match(text, /股东会决议或增资协议/);
});

test('未来期限不能撑起中等把握', () => {
  // 实测中公司章程只抽出了"2030-03-30 股东认缴出资截止日期"，
  // 那是缴款期限，说明不了章程何时形成。
  const deadlineOnly = document(
    '只有缴款期限的章程.pdf',
    null,
    facts({
      documentType: 'company_charter',
      title: '公司章程',
      dates: [
        {
          date: '2030-03-30',
          meaning: '股东认缴出资截止日期',
          evidence: '章程约定认缴期限',
        },
      ],
    })
  );
  const resolved = resolveEvidence(deadlineOnly, []);
  assert.notEqual(resolved.strength, 'medium');
  assert.equal(resolved.confidence, 45);
});

test('签署日期可以撑起中等把握', () => {
  const signed = document(
    '有签署日的章程.pdf',
    null,
    facts({
      documentType: 'company_charter',
      title: '公司章程',
      dates: [
        { date: '2026-03-20', meaning: '章程签署日期', evidence: '落款日期' },
      ],
    })
  );
  assert.equal(resolveEvidence(signed, []).strength, 'medium');
});

test('有交易锚点时提示模型直接采用代码结论', () => {
  const text = describeResolvedEvidence(
    resolveEvidence(preCharter, [postCharter, resolution])
  );
  assert.match(text, /已由代码确定/);
  assert.match(text, /形成于该笔交易之前/);
  assert.match(text, /不要再自行比较金额大小/);
});

test('既无数字也无日期时把握最低', () => {
  const bare = document(
    '未知文件.pdf',
    null,
    facts({ documentType: 'unknown', title: '未知文件' })
  );
  const resolved = resolveEvidence(bare, []);
  assert.equal(resolved.strength, 'none');
  assert.equal(resolved.confidence, 25);
});

test('时间线由代码按日期排序拼出，不调用模型', () => {
  const timeline = buildTimeline([postCharter, resolution, preCharter]);
  assert.deepEqual(
    timeline.map(entry => entry.date),
    ['2026-03-20', '2026-04-10', '2026-04-12']
  );
  assert.equal(timeline[1].sourcePath, '7君柔科技-股东会决议.pdf');
});

test('没有日期的文件不进时间线', () => {
  const undated = document(
    '无日期.pdf',
    null,
    facts({ documentType: 'other', title: '无日期文件' })
  );
  assert.deepEqual(buildTimeline([undated]), []);
});
