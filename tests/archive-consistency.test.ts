import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkArchiveConsistency,
  extractCapitalTransition,
  extractRegisteredCapital,
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
  const transition = extractCapitalTransition(shareholderResolution.facts);
  assert.equal(transition?.before, 11.73624);
  assert.equal(transition?.after, 13.04027);
});

test('减资决议同样能读出前后值，不假设方向', () => {
  const transition = extractCapitalTransition(
    facts({
      documentType: 'shareholder_resolution',
      title: '减资决议',
      evidenceQuotes: ['注册资本由人民币500万元减少至人民币300万元'],
    })
  );
  assert.equal(transition?.before, 500);
  assert.equal(transition?.after, 300);
});

test('从章程里读出它自己记载的注册资本', () => {
  assert.equal(extractRegisteredCapital(preTransactionCharter.facts), 11.73624);
  assert.equal(extractRegisteredCapital(postTransactionCharter.facts), 13.04027);
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
