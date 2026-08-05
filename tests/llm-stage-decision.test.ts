import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDecisionFromParsed as decisionFromParsedForTests,
  buildStageDecisionPrompt as buildStageDecisionPromptForTests,
  parseLlmStageDecisionResponse,
} from '../src/lib/classification/llm-stage-decision';
import type { DocumentFacts } from '../src/lib/classification/document-facts';

function healthyFacts(): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType: 'company_charter',
    rawDocumentType: '公司章程',
    title: '君柔科技公司章程',
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
  };
}

test('解析模型返回的阶段判断', () => {
  const parsed = parseLlmStageDecisionResponse(
    `{"stage":"investment_execution","conf":82,"review":false,"why":"注册资本由1000万增加至1500万，属于交易完成后的新版章程","ev":["注册资本 1000万 → 1500万"],"cx":[]}`
  );
  assert.equal(parsed.stage, 'investment_execution');
  assert.equal(parsed.confidence, 82);
  assert.equal(parsed.review, false);
  assert.deepEqual(parsed.evidence, ['注册资本 1000万 → 1500万']);
  assert.deepEqual(parsed.contradictions, []);
});

test('模型输出被 Markdown 包裹时仍能解析', () => {
  const parsed = parseLlmStageDecisionResponse(
    '```json\n{"stage":"due_diligence","conf":70,"review":true,"why":"尽调报告","ev":[],"cx":[]}\n```'
  );
  assert.equal(parsed.stage, 'due_diligence');
  assert.equal(parsed.review, true);
});

test('模型给出 unknown 时阶段为 null，不视为解析失败', () => {
  const parsed = parseLlmStageDecisionResponse(
    `{"stage":"unknown","conf":10,"review":true,"why":"事实为空","ev":[],"cx":[]}`
  );
  assert.equal(parsed.stage, null);
  assert.equal(parsed.confidence, 10);
});

test('模型编造不存在的阶段时报错，不会静默落到 unknown', () => {
  assert.throws(
    () =>
      parseLlmStageDecisionResponse(
        `{"stage":"投资实施","conf":90,"review":false,"why":"x","ev":[],"cx":[]}`
      ),
    /未知阶段/
  );
});

test('置信度超出范围或缺失时被夹到 0-100', () => {
  assert.equal(
    parseLlmStageDecisionResponse(
      `{"stage":"initiation","conf":180,"review":false,"why":"x","ev":[],"cx":[]}`
    ).confidence,
    100
  );
  assert.equal(
    parseLlmStageDecisionResponse(
      `{"stage":"initiation","review":false,"why":"x","ev":[],"cx":[]}`
    ).confidence,
    0
  );
});

test('响应中没有 JSON 对象时报错', () => {
  assert.throws(
    () => parseLlmStageDecisionResponse('模型拒绝回答。'),
    /没有合法 JSON 对象/
  );
});

test('模型自报矛盾时强制转人工，高把握也不放行', () => {
  // 实测出现过的失败形态：模型标注了与关联文件的金额矛盾，同时给 85 分并判错。
  const decided = decisionFromParsedForTests(
    {
      stage: 'investment_execution',
      confidence: 85,
      review: false,
      reasoning: '注册资本增至11.73624万元',
      evidence: ['存在增资变化'],
      contradictions: ['存在注册资本金额与关联文件矛盾的情况'],
    },
    healthyFacts()
  );
  assert.equal(decided.status, 'decided');
  assert.equal(decided.selectedFolder?.businessStage, 'investment_execution');
  assert.equal(decided.requiresHumanReview, true);
});

test('没有矛盾且事实健康时不会无故转人工', () => {
  const decided = decisionFromParsedForTests(
    {
      stage: 'due_diligence',
      confidence: 80,
      review: false,
      reasoning: '尽职调查报告',
      evidence: ['标题为尽职调查报告'],
      contradictions: [],
    },
    healthyFacts()
  );
  assert.equal(decided.requiresHumanReview, false);
});

test('事实仅来自文件名时强制转人工，模型给高分也不放行', () => {
  const decided = decisionFromParsedForTests(
    {
      stage: 'initiation',
      confidence: 95,
      review: false,
      reasoning: '文件名含立项',
      evidence: [],
      contradictions: [],
    },
    { ...healthyFacts(), sourceQuality: 'filename_only' }
  );
  assert.equal(decided.requiresHumanReview, true);
});

test('abstract 版阶段说明不含任何文件类型清单', () => {
  const abstractPrompt = JSON.stringify(
    buildStageDecisionPromptForTests({
      sourcePath: '公司章程.pdf',
      facts: healthyFacts(),
      stageGuideMode: 'abstract',
    })
  );
  // 这些是 examples 版里逐一列出的文件类型，abstract 版不应出现在阶段说明里。
  for (const listed of [
    '立项会纪要',
    '尽调报告',
    '投资建议书',
    '交割确认函',
    '缴款通知书',
    '出资证明书',
    '银行回单',
    'Teaser',
  ]) {
    assert.equal(
      abstractPrompt.includes(listed),
      false,
      `abstract 版不应出现文件类型「${listed}」`
    );
  }
  // 但判断依据必须保留——那是依据，不是答案。
  assert.match(abstractPrompt, /交易发生之前/);
  assert.match(abstractPrompt, /交易发生之后/);
});

test('examples 版保留文件类型清单，两版确实不同', () => {
  const examplesPrompt = JSON.stringify(
    buildStageDecisionPromptForTests({
      sourcePath: '公司章程.pdf',
      facts: healthyFacts(),
      stageGuideMode: 'examples',
    })
  );
  assert.match(examplesPrompt, /交割确认函/);
  assert.match(examplesPrompt, /立项会纪要/);
});
