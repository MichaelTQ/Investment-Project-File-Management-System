import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  buildConflictReviewPrompt,
  parseConflictReviewResponse,
} from '../src/lib/classification/minimal/conflict-review';
import {
  buildTimeline,
  describeTimeline,
} from '../src/lib/classification/minimal/evidence';
import type { MinimalDocument } from '../src/lib/classification/minimal/store';

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

const charter = document(
  '公司章程.pdf',
  'investment_decision',
  facts({
    documentType: 'company_charter',
    title: '公司章程',
    dates: [{ date: '2026-03-20', meaning: '生效日期', evidence: '章程生效' }],
    evidenceQuotes: ['注册资本为人民币11.73624万元'],
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
        evidence: '注册资本由11.73624万元增加至13.04027万元',
      },
    ],
  })
);

test('时间线由代码按日期排序拼出，不调用模型', () => {
  const timeline = buildTimeline([resolution, charter]);
  assert.deepEqual(
    timeline.map(entry => entry.date),
    ['2026-03-20', '2026-04-10']
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

test('所有日期一视同仁，不按含义挑拣', () => {
  // 曾经的代码只认"签署/批准/生效"这类词，把缴款期限一律丢掉。那是预设：
  // 哪个日期重要应由模型结合上下文判断，代码只负责把日期摆出来。
  const deadline = document(
    '章程.pdf',
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
  const timeline = buildTimeline([deadline]);
  assert.equal(timeline.length, 1);
  // 日期的含义原样带上，交给模型自己判断这是不是文件形成时间。
  assert.match(describeTimeline(timeline), /股东认缴出资截止日期/);
});

test('时间线文本只给文件名，不给目录路径', () => {
  const nested = document(
    '君柔档案/投资决策/公司章程.pdf',
    'investment_decision',
    facts({
      documentType: 'company_charter',
      title: '公司章程',
      dates: [{ date: '2026-03-20', meaning: '生效日期', evidence: '生效' }],
    })
  );
  const text = describeTimeline(buildTimeline([nested]));
  assert.match(text, /公司章程\.pdf/);
  assert.equal(text.includes('投资决策'), false);
  assert.equal(text.includes('君柔档案'), false);
});

/** 冲突复核：代码只把事实摆出来，什么算矛盾由模型判断。 */

test('冲突复核提示不预设矛盾的种类', () => {
  const systemPrompt = String(
    buildConflictReviewPrompt({
      documents: [charter, resolution],
      timeline: buildTimeline([charter, resolution]),
      projectName: '君柔',
      stageDefinitions: 'investment_execution 投资实施：交易已经发生。',
    })[0].content
  );

  assert.match(systemPrompt, /不要假设项目里应当存在某份没有出现的文件/);
  assert.match(systemPrompt, /判断不了就不要报/);
  // 不得出现预先写好的矛盾清单或搭配规则。
  for (const preset of ['交割确认函', '通常应', '常见搭配', '版本先后']) {
    assert.equal(
      systemPrompt.includes(preset),
      false,
      `冲突复核提示里出现了预设“${preset}”`
    );
  }
});

test('冲突复核提示里带上各文件的事实和当前归档阶段', () => {
  const userPrompt = String(
    buildConflictReviewPrompt({
      documents: [charter, resolution],
      timeline: buildTimeline([charter, resolution]),
      stageDefinitions: '',
    })[1].content
  );

  assert.match(userPrompt, /注册资本为人民币11\.73624万元/);
  assert.match(userPrompt, /11\.73624万元 → 13\.04027万元/);
  assert.match(userPrompt, /investment_decision/);
});

test('解析模型给出的冲突列表', () => {
  const findings = parseConflictReviewResponse(
    `{"conflicts":[{"files":["公司章程.pdf"],"what":"章程记载的注册资本与决议变更后的数值不一致","ev":["章程 11.73624万元","决议变更后 13.04027万元"]}]}`
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].sourcePaths, ['公司章程.pdf']);
  assert.match(findings[0].description, /不一致/);
  assert.equal(findings[0].evidence.length, 2);
});

test('没有冲突时返回空数组', () => {
  assert.deepEqual(parseConflictReviewResponse('{"conflicts":[]}'), []);
});

test('缺少描述的条目被丢弃，不产生空提示', () => {
  const findings = parseConflictReviewResponse(
    '{"conflicts":[{"files":["a.pdf"],"ev":[]},{"files":["b.pdf"],"what":"真的有矛盾","ev":[]}]}'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].description, '真的有矛盾');
});

/**
 * 其他文件的归档位置：可以给模型看，但必须说清它的性质。
 *
 * 这个值来自文件实际所在的目录，而归档一律需要人工点确认，所以它是人工确认过的
 * 结果，不是模型自己的输出。措辞上必须标明"人工确认"，否则模型无从判断这条信息
 * 有多可信；同时提示词要求它不得只凭这一条下结论——确认时的默认值就是模型建议，
 * 一路点确认的话，这个"人工确认"实质仍是模型的猜测。
 */
test('时间线标明归档位置是人工确认的结果', () => {
  const text = describeTimeline(buildTimeline([charter, resolution]), {
    showStage: true,
  });
  assert.match(text, /人工确认归入 investment_decision/);
  assert.match(text, /人工确认归入 investment_execution/);
  // 不能写成中性的"已归入"，那会让模型以为是系统自己的判断结果。
  assert.equal(text.includes('（已归入'), false);
});

test('默认不显示归档位置，要显示必须显式打开', () => {
  const text = describeTimeline(buildTimeline([charter]));
  assert.equal(text.includes('人工确认'), false);
  assert.equal(text.includes('investment_decision'), false);
});

test('尚未归档的文件如实标注，不留空让模型猜', () => {
  const pending = document(
    '新文件.pdf',
    null,
    facts({
      documentType: 'company_charter',
      title: '公司章程',
      dates: [{ date: '2026-05-01', meaning: '签署日期', evidence: '落款' }],
    })
  );
  assert.match(
    describeTimeline(buildTimeline([pending]), { showStage: true }),
    /尚未归档/
  );
});
