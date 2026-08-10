import assert from 'node:assert/strict';
import test from 'node:test';

import { runDeepen, type DeepenDeps } from '../src/lib/classification/deepen/agent';
import { DEEPEN_BUDGET } from '../src/lib/classification/deepen/types';
import { createFallbackDocumentFacts } from '../src/lib/classification/document-facts';
import type { MinimalDocument } from '../src/lib/classification/minimal/store';

/**
 * 深挖循环的行为测试。
 *
 * 测的是这个模块唯一的自有逻辑——**预算、轮次、轨迹、停止原因**。工具本身和判定器
 * 都被换成假的：它们要联网，而且它们的正确性由各自的测试负责。
 *
 * 三个模型网关、S3、判定器的接缝由 DeepenDeps 提供，见 agent.ts 里的说明。
 */

function doc(sourcePath: string, read: boolean): MinimalDocument {
  const facts = createFallbackDocumentFacts(sourcePath, "测试占位");
  return {
    sourcePath,
    facts: read
      ? { ...facts, title: sourcePath, evidenceQuotes: ['已读过的内容'] }
      : facts,
    stage: 'investment_execution',
    stageSource: 'naming_rule',
    archivedFileId: `af-${sourcePath}`,
    updatedAt: Date.now(),
  };
}

const ARCHIVE = {
  schemaVersion: 1 as const,
  projectId: 'p1',
  updatedAt: Date.now(),
  documents: [doc('章程.pdf', false), doc('决议.pdf', true)],
  dismissedFindings: [],
};

/** 假模型：按脚本逐轮返回。每一项是"这一轮要调的工具"，null 表示给最终答复。 */
function scriptedClient(
  script: Array<Array<{ name: string; args: string }> | null>
) {
  let round = 0;
  const seen: string[] = [];
  const client = {
    chat: {
      completions: {
        stream(body: { messages: Array<{ role: string }> }) {
          const step = script[Math.min(round, script.length - 1)];
          round += 1;
          seen.push(String(body.messages.length));
          return {
            async finalChatCompletion() {
              if (step === null) {
                return {
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: { role: 'assistant', content: '取证完毕：找到了变更记载。' },
                    },
                  ],
                };
              }
              return {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      content: '',
                      tool_calls: step.map((item, index) => ({
                        id: `call-${round}-${index}`,
                        type: 'function',
                        function: { name: item.name, arguments: item.args },
                      })),
                    },
                  },
                ],
              };
            },
          };
        },
      },
    },
  };
  return { client, messageCounts: seen };
}

function makeDeps(
  script: Array<Array<{ name: string; args: string }> | null>,
  onDecide?: () => void
): DeepenDeps {
  const { client } = scriptedClient(script);
  return {
    createClient: () => client as never,
    loadArchive: async () => ARCHIVE as never,
    decide: async () => {
      onDecide?.();
      return {
        status: 'success' as const,
        decision: {
          status: 'decided' as const,
          selectedFolder: null,
          businessStage: null,
          evidence: [],
          contradictions: [],
          requiresHumanReview: true,
          reasoning: '来自判定器的结论',
          policyVersion: 'test',
        },
      };
    },
  };
}

test('模型不再要工具时停下，停止原因是 completed', async () => {
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '章程.pdf' },
    makeDeps([[{ name: 'list_project_documents', args: '{}' }], null])
  );

  assert.equal(result.stopReason, 'completed');
  assert.equal(result.roundCount, 2);
  assert.equal(result.trace.length, 2);
  assert.equal(result.trace[0].toolCalls[0].tool, 'list_project_documents');
  assert.match(result.closingNote, /取证完毕/);
});

test('结论来自判定器，深挖自己不判阶段', async () => {
  let decideCalled = 0;
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '章程.pdf' },
    makeDeps([null], () => {
      decideCalled += 1;
    })
  );

  assert.equal(decideCalled, 1, '必须交回判定器，不能自己下结论');
  assert.equal(result.decision?.reasoning, '来自判定器的结论');
});

test('轮数用尽时停下，停止原因是 round_budget', async () => {
  // 脚本只有一项且不是 null，最后一项会被重复使用——模型永远在要工具。
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '章程.pdf' },
    makeDeps([[{ name: 'get_project_timeline', args: '{}' }]])
  );

  assert.equal(result.stopReason, 'round_budget');
  assert.equal(result.roundCount, DEEPEN_BUDGET.maxRounds);
  assert.match(result.closingNote, /轮数用尽/);
});

test('轨迹记下每一轮的工具调用、参数原文和耗时', async () => {
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '章程.pdf' },
    makeDeps([
      [
        { name: 'read_document_facts', args: '{"file_name":"决议.pdf"}' },
        { name: 'get_project_timeline', args: '{}' },
      ],
      null,
    ])
  );

  const first = result.trace[0];
  assert.equal(first.toolCalls.length, 2, '同一轮的并发调用要全部记下');
  assert.equal(first.toolCalls[0].rawArguments, '{"file_name":"决议.pdf"}');
  assert.equal(first.toolCalls[0].isError, false);
  assert.ok(first.durationMs >= 0);
});

test('参数不是合法 JSON 时记为错误，但循环继续', async () => {
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '章程.pdf' },
    makeDeps([[{ name: 'read_document_facts', args: '{坏的' }], null])
  );

  assert.equal(result.trace[0].toolCalls[0].isError, true);
  assert.equal(result.stopReason, 'completed', '单个工具出错不该中断整个循环');
});

test('读没读过内容的文件会被挡下，并提示改用 extract', async () => {
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '章程.pdf' },
    makeDeps([[{ name: 'read_document_facts', args: '{"file_name":"章程.pdf"}' }], null])
  );

  const call = result.trace[0].toolCalls[0];
  assert.equal(call.isError, true);
  assert.match(call.resultBrief, /extract_document_facts/);
});

test('项目档案里没有目标文件时直接返回错误，不进循环', async () => {
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '不存在.pdf' },
    makeDeps([null])
  );

  assert.equal(result.stopReason, 'error');
  assert.equal(result.roundCount, 0);
  assert.equal(result.decision, null);
  assert.match(result.error ?? '', /没有这份文件/);
});

test('未知工具名返回错误而不是抛异常', async () => {
  const result = await runDeepen(
    { projectId: 'p1', sourcePath: '章程.pdf' },
    makeDeps([[{ name: 'delete_everything', args: '{}' }], null])
  );

  assert.equal(result.trace[0].toolCalls[0].isError, true);
  assert.match(result.trace[0].toolCalls[0].resultBrief, /未知工具/);
});
