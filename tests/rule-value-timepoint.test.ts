import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import { checkValueTimepointConflicts } from '../src/lib/classification/minimal/rule-checks';
import type { MinimalDocument } from '../src/lib/classification/minimal/store';

/**
 * 数值时点比对。
 *
 * 这条规则唯一能证明的事情是：记着变更前值的文件，不可能形成于变更完成之后。
 * 它**证明不了**"记着变更前值就该归到更早的阶段"——促成变更的文件全都记着变更前的
 * 值，且与记载变更的文件同处一个阶段。下面的用例守的就是这条边界。
 */

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

/** 记载变更的那份：注册资本 220.9526 → 225.0443。 */
const resolution = document(
  '2、佰特微股东会决议.pdf',
  'investment_execution',
  facts({
    documentType: 'shareholder_resolution',
    title: '股东会决议',
    transactionChanges: [
      {
        field: '公司注册资本',
        before: '220.9526万元',
        after: '225.0443万元',
        evidence: '注册资本由220.9526万元增加至225.0443万元',
      },
    ],
  })
);

test('促成变更的文件与变更同处一个阶段，不报', () => {
  // 佰特微实测：投资合同书记的是交易起点的注册资本，和决议同在投资实施。
  // 这是一笔交易的正常形态——合同先签、决议再批——规则却每次都报。
  const contract = document(
    '1、中山致远&佰特微-投资合同书.pdf',
    'investment_execution',
    facts({
      documentType: 'capital_increase_agreement',
      title: '投资合同书',
      evidenceQuotes: ['公司注册资本为人民币220.9526万元'],
    })
  );

  assert.deepEqual(
    checkValueTimepointConflicts([resolution, contract]),
    []
  );
});

test('变更前的值出现在更晚的阶段，报', () => {
  // 这一种没法用"同一笔交易"解释：变更完成之后不会再产生记录变更前状态的文件。
  const laterDocument = document(
    '投后台账.pdf',
    'post_investment',
    facts({
      documentType: 'other',
      title: '台账',
      evidenceQuotes: ['公司注册资本为人民币220.9526万元'],
    })
  );

  const findings = checkValueTimepointConflicts([resolution, laterDocument]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].description, /比记载这次变更的/);
  assert.deepEqual(findings[0].sourcePaths, [
    '投后台账.pdf',
    '2、佰特微股东会决议.pdf',
  ]);
});

test('变更前的值出现在更早的阶段，不报', () => {
  const earlier = document(
    '佰特微章程-章程2024.11.pdf',
    'investment_decision',
    facts({
      documentType: 'company_charter',
      title: '公司章程',
      evidenceQuotes: ['公司注册资本为人民币220.9526万元'],
    })
  );

  assert.deepEqual(checkValueTimepointConflicts([resolution, earlier]), []);
});

test('记着变更后的值却归在更早阶段，不报', () => {
  // 交易文件经常前瞻性地写明变更后的目标值，那是约定不是既成事实。
  const forwardLooking = document(
    '投资意向书.pdf',
    'investment_decision',
    facts({
      documentType: 'other',
      title: '意向书',
      evidenceQuotes: ['本次交易完成后公司注册资本为人民币225.0443万元'],
    })
  );

  assert.deepEqual(
    checkValueTimepointConflicts([resolution, forwardLooking]),
    []
  );
});

test('同时记着变更前后两个值的文件不参与比对', () => {
  const bothValues = document(
    '董事会决议.pdf',
    'post_investment',
    facts({
      documentType: 'board_resolution',
      title: '董事会决议',
      evidenceQuotes: [
        '公司注册资本由220.9526万元变更为225.0443万元',
      ],
    })
  );

  assert.deepEqual(checkValueTimepointConflicts([resolution, bothValues]), []);
});

test('尚未归档的文件不参与比对', () => {
  const unfiled = document(
    '待归档.pdf',
    null,
    facts({
      documentType: 'other',
      title: '待归档',
      evidenceQuotes: ['公司注册资本为人民币220.9526万元'],
    })
  );

  assert.deepEqual(checkValueTimepointConflicts([resolution, unfiled]), []);
});
