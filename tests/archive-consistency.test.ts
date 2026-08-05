import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkArchiveConsistency,
  extractFieldTransitions,
  extractStatedValue,
  type ArchiveDocument,
} from '../src/lib/classification/archive-consistency';
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

// 君柔项目的真实数字：注册资本由 11.73624 万元增至 13.04027 万元。
const preTransactionCharter: ArchiveDocument = {
  sourcePath: '公司章程.pdf',
  currentStage: 'investment_decision',
  facts: facts({
    documentType: 'company_charter',
    title: '深圳君柔科技有限公司章程',
    dates: [{ date: '2026-03-20', meaning: '章程生效日期', evidence: '章程载明生效日期' }],
    evidenceQuotes: ['注册资本为人民币11.73624万元'],
  }),
};

const postTransactionCharter: ArchiveDocument = {
  sourcePath: '6君柔科技-公司章程.pdf',
  currentStage: 'investment_execution',
  facts: facts({
    documentType: 'company_charter',
    title: '深圳君柔科技有限公司章程',
    dates: [{ date: '2026-04-12', meaning: '章程修订生效', evidence: '修订后章程' }],
    evidenceQuotes: ['注册资本为人民币13.04027万元'],
  }),
};

const shareholderResolution: ArchiveDocument = {
  sourcePath: '7君柔科技-股东会决议.pdf',
  currentStage: 'investment_execution',
  facts: facts({
    documentType: 'shareholder_resolution',
    title: '君柔科技股东会决议',
    dates: [{ date: '2026-04-10', meaning: '股东会批准日期', evidence: '决议形成日期' }],
    transactionChanges: [
      {
        field: '注册资本',
        before: '11.73624万元',
        after: '13.04027万元',
        evidence: '股东会批准注册资本由11.73624万元增加至13.04027万元',
      },
    ],
  }),
};

test('从股东会决议里读出交易的变更前后值', () => {
  const [transition] = extractFieldTransitions(shareholderResolution.facts);
  assert.equal(transition.field, '注册资本');
  assert.equal(transition.before.amount, 11.73624);
  assert.equal(transition.after.amount, 13.04027);
  assert.equal(transition.before.unit, '万元');
});

test('减资决议同样能读出前后值，不假设方向', () => {
  const [transition] = extractFieldTransitions(
    facts({
      documentType: 'shareholder_resolution',
      title: '减资决议',
      evidenceQuotes: ['注册资本由人民币500万元减少至人民币300万元'],
    })
  );
  assert.equal(transition.before.amount, 500);
  assert.equal(transition.after.amount, 300);
});

test('从章程里读出它自己记载的注册资本', () => {
  assert.equal(
    extractStatedValue(preTransactionCharter.facts, '注册资本')?.amount,
    11.73624
  );
  assert.equal(
    extractStatedValue(postTransactionCharter.facts, '注册资本')?.amount,
    13.04027
  );
});

test('分类正确时校验器保持沉默', () => {
  const findings = checkArchiveConsistency([
    preTransactionCharter,
    postTransactionCharter,
    shareholderResolution,
  ]);
  assert.deepEqual(
    findings.filter(item => item.kind === 'transaction_side_conflict'),
    []
  );
});

test('交易前的章程被误归到投资实施时，数字链能指出来', () => {
  // 这正是实测中模型判错的那一份：注册资本 11.73624 万元与变更前值一致。
  const misfiled: ArchiveDocument = {
    ...preTransactionCharter,
    currentStage: 'investment_execution',
  };
  const findings = checkArchiveConsistency([
    misfiled,
    postTransactionCharter,
    shareholderResolution,
  ]);
  const conflict = findings.find(
    item =>
      item.kind === 'transaction_side_conflict' &&
      item.sourcePath === '公司章程.pdf'
  );
  assert.ok(conflict, '应当指出这份章程形成于交易之前');
  assert.equal(conflict?.constraint, '形成于该笔交易之前');
  assert.deepEqual(conflict?.relatedSourcePaths, ['7君柔科技-股东会决议.pdf']);
});

test('交易后的章程被误归到投资决策时，数字链同样能指出来', () => {
  const misfiled: ArchiveDocument = {
    ...postTransactionCharter,
    currentStage: 'investment_decision',
  };
  const findings = checkArchiveConsistency([
    preTransactionCharter,
    misfiled,
    shareholderResolution,
  ]);
  const conflict = findings.find(
    item =>
      item.kind === 'transaction_side_conflict' &&
      item.sourcePath === '6君柔科技-公司章程.pdf'
  );
  assert.equal(conflict?.constraint, '形成于该笔交易之后');
});

test('交易文件还没进来时校验器无话可说，不得当作认可', () => {
  const misfiled: ArchiveDocument = {
    ...preTransactionCharter,
    currentStage: 'investment_execution',
  };
  const findings = checkArchiveConsistency([misfiled, postTransactionCharter]);
  assert.deepEqual(
    findings.filter(item => item.kind === 'transaction_side_conflict'),
    [],
    '缺少交易锚点时数字链不应臆断'
  );
});

test('晚到的股东会决议能回头纠正先前判错的章程', () => {
  // 本方案的核心假设：决定性证据常常比它要决定的文件晚到。
  const misfiled: ArchiveDocument = {
    ...preTransactionCharter,
    currentStage: 'investment_execution',
  };
  const beforeResolution = checkArchiveConsistency([
    misfiled,
    postTransactionCharter,
  ]);
  const afterResolution = checkArchiveConsistency([
    misfiled,
    postTransactionCharter,
    shareholderResolution,
  ]);

  assert.equal(beforeResolution.length, 0);
  assert.equal(
    afterResolution.some(
      item =>
        item.kind === 'transaction_side_conflict' &&
        item.sourcePath === '公司章程.pdf'
    ),
    true
  );
});

test('同类型文件里日期早的不应归到更晚的阶段', () => {
  const findings = checkArchiveConsistency([
    { ...preTransactionCharter, currentStage: 'investment_execution' },
    { ...postTransactionCharter, currentStage: 'investment_decision' },
  ]);
  const conflict = findings.find(item => item.kind === 'version_order_conflict');
  assert.equal(conflict?.sourcePath, '公司章程.pdf');
});

test('跨类型不比日期：增资协议早于股东会决议但同属投资实施', () => {
  const agreement: ArchiveDocument = {
    sourcePath: '2君柔-增资协议.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'capital_increase_agreement',
      title: '增资协议',
      dates: [{ date: '2026-04-01', meaning: '签署日期', evidence: '协议签署' }],
    }),
  };
  const findings = checkArchiveConsistency([agreement, shareholderResolution]);
  assert.deepEqual(
    findings.filter(item => item.kind === 'version_order_conflict'),
    []
  );
});

test('内容相同的文件归到不同阶段会被指出', () => {
  const findings = checkArchiveConsistency([
    {
      sourcePath: '立项前/1.pdf',
      currentStage: 'pre_initiation',
      fingerprint: 'sha256:aaa',
      facts: facts({ documentType: 'confidentiality_agreement', title: '保密协议' }),
    },
    {
      sourcePath: '立项前/NDA保密协议.pdf',
      currentStage: 'initiation',
      fingerprint: 'sha256:aaa',
      facts: facts({ documentType: 'confidentiality_agreement', title: '保密协议' }),
    },
  ]);
  assert.equal(
    findings.filter(item => item.kind === 'duplicate_stage_mismatch').length,
    2
  );
});

test('缺少指纹时跳过重复检查而不是误报', () => {
  const findings = checkArchiveConsistency([
    {
      sourcePath: 'a.pdf',
      currentStage: 'pre_initiation',
      facts: facts({ documentType: 'confidentiality_agreement', title: '保密协议' }),
    },
    {
      sourcePath: 'b.pdf',
      currentStage: 'initiation',
      facts: facts({ documentType: 'confidentiality_agreement', title: '保密协议' }),
    },
  ]);
  assert.deepEqual(
    findings.filter(item => item.kind === 'duplicate_stage_mismatch'),
    []
  );
});

test('有交割确认函却没有增资协议时提示档案缺口', () => {
  const findings = checkArchiveConsistency([
    {
      sourcePath: '5交割确认函.pdf',
      currentStage: 'investment_execution',
      facts: facts({ documentType: 'closing_confirmation', title: '交割确认函' }),
    },
  ]);
  const gap = findings.find(
    item => item.kind === 'missing_companion_document'
  );
  assert.ok(gap);
  assert.equal(gap?.relatedSourcePaths[0], '5交割确认函.pdf');
});

test('空项目不产生任何提示', () => {
  assert.deepEqual(checkArchiveConsistency([]), []);
});

test('未来缴款期限不被当作文件日期，不产生假的先后矛盾', () => {
  // 实测：两份章程都只抽出了"2030-03-30 股东认缴出资截止日期"。
  // 若把它当文件日期，一旦另一份抽到的是签署日，就会比出错误的先后关系。
  const deadlineCharter: ArchiveDocument = {
    sourcePath: '缴款期限章程.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'company_charter',
      title: '公司章程',
      dates: [
        {
          date: '2030-03-30',
          meaning: '股东认缴出资截止日期',
          evidence: '认缴期限',
        },
      ],
    }),
  };
  const signedCharter: ArchiveDocument = {
    sourcePath: '签署章程.pdf',
    currentStage: 'investment_decision',
    facts: facts({
      documentType: 'company_charter',
      title: '公司章程',
      dates: [
        { date: '2026-03-20', meaning: '章程签署日期', evidence: '落款' },
      ],
    }),
  };
  const findings = checkArchiveConsistency([deadlineCharter, signedCharter]);
  assert.deepEqual(
    findings.filter(item => item.kind === 'version_order_conflict'),
    [],
    '缺少形成日期的一方应被跳过，而不是拿缴款期限去比'
  );
});

test('持股比例也能作为交易锚点，不限于注册资本', () => {
  const equityResolution: ArchiveDocument = {
    sourcePath: '股权转让决议.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'shareholder_resolution',
      title: '股权转让决议',
      transactionChanges: [
        {
          field: '创始人持股比例',
          before: '65%',
          after: '52%',
          evidence: '决议同意创始人持股比例由65%变更为52%',
        },
      ],
    }),
  };
  const preCharter: ArchiveDocument = {
    sourcePath: '转让前章程.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'company_charter',
      title: '公司章程',
      evidenceQuotes: ['创始人持股比例为65%'],
    }),
  };

  const conflict = checkArchiveConsistency([
    equityResolution,
    preCharter,
  ]).find(item => item.kind === 'transaction_side_conflict');
  assert.ok(conflict, '持股比例应当能定位交易先后');
  assert.equal(conflict?.sourcePath, '转让前章程.pdf');
  assert.equal(conflict?.constraint, '形成于该笔交易之前');
  assert.match(conflict?.reason ?? '', /持股比例/);
});

test('实缴出资额也能作为交易锚点', () => {
  const paidIn: ArchiveDocument = {
    sourcePath: '增资协议.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'capital_increase_agreement',
      title: '增资协议',
      transactionChanges: [
        {
          field: '实缴出资额',
          before: '200万元',
          after: '1200万元',
          evidence: '实缴出资额由200万元增加至1200万元',
        },
      ],
    }),
  };
  const later: ArchiveDocument = {
    sourcePath: '出资证明书.pdf',
    currentStage: 'due_diligence',
    facts: facts({
      documentType: 'capital_contribution_certificate',
      title: '出资证明书',
      evidenceQuotes: ['实缴出资额1200万元'],
    }),
  };

  const conflict = checkArchiveConsistency([paidIn, later]).find(
    item => item.kind === 'transaction_side_conflict'
  );
  assert.equal(conflict?.constraint, '形成于该笔交易之后');
  assert.match(conflict?.reason ?? '', /实缴出资额/);
});

test('单位不同的数值不会被误判为相等', () => {
  const resolution: ArchiveDocument = {
    sourcePath: '决议.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'shareholder_resolution',
      title: '决议',
      transactionChanges: [
        {
          field: '注册资本',
          before: '1000万元',
          after: '1500万元',
          evidence: '注册资本由1000万元增加至1500万元',
        },
      ],
    }),
  };
  // 1000 元 与 1000 万元 数值相同但单位不同，不构成匹配。
  const unrelated: ArchiveDocument = {
    sourcePath: '无关文件.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'company_charter',
      title: '章程',
      evidenceQuotes: ['注册资本为1000元'],
    }),
  };
  assert.deepEqual(
    checkArchiveConsistency([resolution, unrelated]).filter(
      item => item.kind === 'transaction_side_conflict'
    ),
    []
  );
});

test('字段名写法不同也能对上', () => {
  const resolution: ArchiveDocument = {
    sourcePath: '决议.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'shareholder_resolution',
      title: '决议',
      transactionChanges: [
        {
          field: '公司注册资本总额',
          before: '1000万元',
          after: '1500万元',
          evidence: '公司注册资本总额由1000万元增加至1500万元',
        },
      ],
    }),
  };
  const charter: ArchiveDocument = {
    sourcePath: '章程.pdf',
    currentStage: 'investment_execution',
    facts: facts({
      documentType: 'company_charter',
      title: '章程',
      evidenceQuotes: ['注册资本为1000万元'],
    }),
  };
  const conflict = checkArchiveConsistency([resolution, charter]).find(
    item => item.kind === 'transaction_side_conflict'
  );
  assert.equal(conflict?.constraint, '形成于该笔交易之前');
});
