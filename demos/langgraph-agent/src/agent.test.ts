import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AIMessage } from '@langchain/core/messages';

import { buildProject } from './fixture.js';
import { runAgent } from './graph.js';
import { scriptedModel, type AgentModel } from './model.js';
import { BUDGET } from './types.js';

/**
 * 循环本身（预算、轮次、轨迹、停止原因）是这个模块唯一的自有逻辑，也是唯一会出微妙
 * 错误的地方。它却夹在模型网关中间——所以模型是可注入的，这里全部离线跑。
 *
 * 四种停止原因每一种都要有测试。**评测时"想清楚了"和"被预算掐断"不能混**：
 * 混了的话，一次因为超时而没读到关键文件的运行，会被记成"系统判不出这类文件"。
 */

const target = '待归档/公司章程-B.pdf';

/** 永远要工具、永不收尾的模型，用来把轮数打到上限。 */
const neverStops: AgentModel = {
  label: 'never-stops',
  async invoke() {
    return new AIMessage({
      content: '',
      tool_calls: [{ name: 'list_project_documents', args: {}, id: `x${Math.random()}` }],
    });
  },
};

test('取证够了自己停：stopReason = completed，且只读了真正定结论的两份', async () => {
  const result = await runAgent({
    targetSourcePath: target,
    documents: buildProject(),
    model: scriptedModel('focused'),
  });

  assert.equal(result.stopReason, 'completed');
  assert.equal(result.extractCount, 2);
  assert.deepEqual(
    result.gathered.map(p => p.split('/').pop()),
    ['公司章程-B.pdf', '股东会决议.pdf']
  );
});

test('乱读时预算兜住：stopReason = extract_budget，读取次数不超上限', async () => {
  const result = await runAgent({
    targetSourcePath: target,
    documents: buildProject(),
    model: scriptedModel('greedy'),
  });

  assert.equal(result.stopReason, 'extract_budget');
  assert.equal(result.extractCount, BUDGET.maxExtracts);
  // 触顶后要求模型说清缺什么，而不是被硬切断。
  assert.match(result.closingNote, /还缺一份/);
});

test('模型不肯收尾时轮数兜住：stopReason = round_budget', async () => {
  const result = await runAgent({
    targetSourcePath: target,
    documents: buildProject(),
    model: neverStops,
  });

  assert.equal(result.stopReason, 'round_budget');
  assert.equal(result.roundCount, BUDGET.maxRounds);
});

test('墙钟兜住：stopReason = timeout', async () => {
  const result = await runAgent({
    targetSourcePath: target,
    documents: buildProject(),
    model: neverStops,
    extractLatencyMs: 0,
    wallClockMs: 1,
  });

  assert.equal(result.stopReason, 'timeout');
  assert.ok(result.roundCount < BUDGET.maxRounds, '应该在轮数用尽之前就被墙钟掐断');
});

test('agent 不判阶段：结论来自判定器，且永远要求人工确认', async () => {
  const result = await runAgent({
    targetSourcePath: target,
    documents: buildProject(),
    model: scriptedModel('focused'),
  });

  assert.equal(result.decision?.stage, 'investment_execution');
  assert.equal(result.decision?.requiresHumanReview, true);
  // 判定理由必须指着具体数字，不能是"章程通常属于投资实施"这类类型先验。
  assert.ok(
    result.decision!.evidence.some(item => item.includes('1304.027')),
    '证据里必须出现决定性的那个数字'
  );
});

test('减法评测：不给它取证，同一份文件判不出来', async () => {
  // 把 agent 换成"什么都不查、直接收尾"，判定器拿到的就只有文件名占位事实。
  const doesNothing: AgentModel = {
    label: 'does-nothing',
    async invoke() {
      return new AIMessage('不查了，直接判。');
    },
  };
  const result = await runAgent({
    targetSourcePath: target,
    documents: buildProject(),
    model: doesNothing,
  });

  assert.equal(result.extractCount, 0);
  assert.equal(result.decision?.stage, null);
  assert.equal(result.decision?.requiresHumanReview, true);
});

test('工具层也有一道预算闸门：模型无视提示词硬读第 4 份时被拒', async () => {
  const result = await runAgent({
    targetSourcePath: target,
    documents: buildProject(),
    model: scriptedModel('greedy'),
  });

  // greedy 计划里第 4 次 extract 在图层被收尾提示拦下，读取次数停在上限。
  assert.equal(result.extractCount, BUDGET.maxExtracts);
  const extracts = result.records.filter(r => r.tool === 'extract_document_facts');
  assert.ok(extracts.length <= BUDGET.maxExtracts + 1);
  assert.ok(extracts.filter(r => !r.isError).length === BUDGET.maxExtracts);
});
