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
  assert.match(text, /不要再自行比较数值大小/);
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

/**
 * 锚点召回率：以前只有四种决议/协议能当锚点，交割确认函、缴款通知书、变更后的
 * 营业执照这些同样写明了前后值的文件全被挡掉，然后静默退回先验推测。
 */

test('交割确认函写明前后值时可以作为锚点', () => {
  const closing = document(
    '交割确认函.pdf',
    'investment_execution',
    facts({
      documentType: 'closing_confirmation',
      title: '交割确认函',
      transactionChanges: [
        {
          field: '注册资本',
          before: '11.73624万元',
          after: '13.04027万元',
          evidence: '交割后注册资本由11.73624万元变更为13.04027万元',
        },
      ],
    })
  );

  const resolved = resolveEvidence(preCharter, [closing]);
  assert.equal(resolved.transactionSide?.side, 'before');
  assert.equal(resolved.strength, 'high');
  assert.equal(resolved.anchorDiagnostic, null);
});

test('尽调报告转述的历史增资不能当锚点', () => {
  const dueDiligence = document(
    '尽职调查报告.pdf',
    'due_diligence',
    facts({
      documentType: 'due_diligence_report',
      title: '尽职调查报告',
      transactionChanges: [
        {
          field: '注册资本',
          before: '11.73624万元',
          after: '13.04027万元',
          evidence: '标的公司历史上注册资本由11.73624万元增加至13.04027万元',
        },
      ],
    })
  );

  const resolved = resolveEvidence(preCharter, [dueDiligence]);
  assert.equal(resolved.transactionSide, null);
  // 挡掉了，但要说清是"挡掉的"，不能说成项目里没有这份文件。
  assert.equal(resolved.anchorDiagnostic?.reason, 'anchor_type_rejected');
  assert.match(
    resolved.anchorDiagnostic?.detail ?? '',
    /尽职调查报告\.pdf/
  );
});

/** 失败可见性：三种"没找到锚点"必须能区分开，处置方式完全不同。 */

test('数值对不上号时明确报异常，而不是退回先验推测', () => {
  const orphanCharter = document(
    '章程.pdf',
    null,
    facts({
      documentType: 'company_charter',
      title: '公司章程',
      evidenceQuotes: ['注册资本为人民币12.5万元'],
    })
  );
  const resolution = document(
    '股东会决议.pdf',
    'investment_execution',
    facts({
      documentType: 'shareholder_resolution',
      title: '股东会决议',
      transactionChanges: [
        {
          field: '注册资本',
          before: '11.73624万元',
          after: '13.04027万元',
          evidence: '注册资本由11.73624万元增加至13.04027万元',
        },
      ],
    })
  );

  const resolved = resolveEvidence(orphanCharter, [resolution]);
  assert.equal(resolved.transactionSide, null);
  assert.equal(resolved.anchorDiagnostic?.reason, 'value_mismatch');
  assert.match(resolved.anchorDiagnostic?.detail ?? '', /12\.5/);
  assert.match(resolved.basis, /对不上/);

  // 对不上号时不能再拿"金额低者形成较早"糊过去，那个先验的前提已被证伪。
  const described = describeResolvedEvidence(resolved);
  assert.match(described, /结果异常/);
  assert.equal(described.includes('倾向性推测'), false);
});

test('有锚点但本文件没写该字段时，说清缺的是哪个字段', () => {
  const silentCharter = document(
    '章程.pdf',
    null,
    facts({ documentType: 'company_charter', title: '公司章程' })
  );
  const resolution = document(
    '股东会决议.pdf',
    'investment_execution',
    facts({
      documentType: 'shareholder_resolution',
      title: '股东会决议',
      transactionChanges: [
        {
          field: '注册资本',
          before: '11.73624万元',
          after: '13.04027万元',
          evidence: '注册资本由11.73624万元增加至13.04027万元',
        },
      ],
    })
  );

  const resolved = resolveEvidence(silentCharter, [resolution]);
  assert.equal(resolved.anchorDiagnostic?.reason, 'field_not_stated');
  assert.deepEqual(resolved.anchorDiagnostic?.fields, ['注册资本']);
  assert.match(describeResolvedEvidence(resolved), /注册资本/);
});

test('项目里只有这一份文件时如实说明，不报成缺少交易记录', () => {
  const resolved = resolveEvidence(preCharter, []);
  assert.equal(resolved.anchorDiagnostic?.reason, 'no_other_documents');
});

test('交易文件因类型未识别被挡掉时，如实说明而不是报"缺少交易文件"', () => {
  // 类型抽取失败（unknown）的股东会决议：内容里明明写了前后值。
  const untypedResolution = document(
    '股东会决议.pdf',
    'investment_execution',
    facts({
      documentType: 'unknown',
      title: '股东会决议',
      transactionChanges: [
        {
          field: '注册资本',
          before: '11.73624万元',
          after: '13.04027万元',
          evidence: '注册资本由11.73624万元增加至13.04027万元',
        },
      ],
    })
  );

  const resolved = resolveEvidence(postCharter, [untypedResolution]);
  assert.equal(resolved.transactionSide, null);
  assert.equal(resolved.anchorDiagnostic?.reason, 'anchor_type_rejected');
  assert.match(resolved.anchorDiagnostic?.detail ?? '', /股东会决议\.pdf/);
  assert.match(resolved.anchorDiagnostic?.detail ?? '', /unknown/);
  // 上面的 reason 断言已经排除了"项目里没有交易记录"这种说法——
  // 文件就在项目里，只是被类型挡掉了，两者对用户的含义完全不同。
  assert.match(describeResolvedEvidence(resolved), /未采信/);
});
