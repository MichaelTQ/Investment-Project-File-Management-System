import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLlmStageDecisionResponse } from '../src/lib/classification/llm-stage-decision';

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
