import {
  callModel,
  closeSession,
  emptyResult,
  isTimedOut,
  maybeWarnBudget,
  openSession,
  runToolCalls,
  type DeepenDeps,
} from './shared';
import {
  DEEPEN_BUDGET,
  type DeepenParams,
  type DeepenResult,
  type DeepenStopReason,
} from './types';

/**
 * 编排方式一：手写的 while 循环。**线上默认走这套。**
 *
 * **循环本身就是下面那三十行。** 问模型 → 它要工具就执行、把结果塞回去 → 再问 →
 * 直到它不再要工具。剩下的都是预算、轨迹和边界。
 *
 * 和 graph.ts 的差别只有控制流：那边把"问"和"做"拆成两个节点、用条件边连起来；
 * 这边就是一个 while 加两个 break。工具、预算、提示词、判定器完全共用（见 shared.ts）。
 *
 * 两套并存的意义在测试里——同一份假模型、同一组断言，两边都必须过。
 */
export async function runDeepenLoop(
  params: DeepenParams,
  deps: DeepenDeps
): Promise<DeepenResult> {
  const startedAt = Date.now();

  const opened = await openSession(params, deps, startedAt);
  if ('error' in opened) {
    return emptyResult(params, 'loop', startedAt, 'error', { error: opened.error });
  }
  const session = opened.session;

  let stopReason: DeepenStopReason = 'round_budget';
  let closingNote = '';
  let round = 0;

  try {
    while (round < DEEPEN_BUDGET.maxRounds) {
      if (isTimedOut(session)) {
        stopReason = 'timeout';
        break;
      }
      round += 1;
      const roundStartedAt = Date.now();

      const turn = await callModel(session);
      if (!turn) {
        session.trace.push({
          round,
          message: '',
          toolCalls: [],
          durationMs: Date.now() - roundStartedAt,
          finishReason: null,
        });
        return emptyResult(params, 'loop', startedAt, 'error', {
          error: '网关没有返回消息内容',
          trace: session.trace,
          extractCount: session.context.extractCount,
          roundCount: round,
          modelCalls: session.modelCalls,
        });
      }

      // 没有工具调用 = 这是最终答复，取证结束。
      if (turn.isFinal) {
        closingNote = turn.message.content?.trim() ?? '';
        stopReason = 'completed';
        session.trace.push({
          round,
          message: closingNote,
          toolCalls: [],
          durationMs: Date.now() - roundStartedAt,
          finishReason: turn.finishReason,
        });
        break;
      }

      const toolCalls = await runToolCalls(session, turn.message, round);
      session.trace.push({
        round,
        message: turn.message.content?.trim() ?? '',
        toolCalls,
        durationMs: Date.now() - roundStartedAt,
        finishReason: turn.finishReason,
      });

      // 预算触顶时追加一句，让它收尾并说清缺什么，而不是被硬切断。
      maybeWarnBudget(session);
    }

    if (round >= DEEPEN_BUDGET.maxRounds && stopReason === 'round_budget') {
      closingNote = '轮数用尽，未给出取证结论。';
    }
    if (stopReason === 'timeout') {
      closingNote = '超时中断，未给出取证结论。';
    }
    if (session.budgetWarned && stopReason === 'completed') {
      stopReason = 'extract_budget';
    }

    return closeSession(params, deps, session, 'loop', stopReason, closingNote, round);
  } catch (error) {
    return emptyResult(params, 'loop', startedAt, 'error', {
      error: error instanceof Error ? error.message : String(error),
      trace: session.trace,
      extractCount: session.context.extractCount,
      roundCount: round,
      gatheredFacts: session.gatheredOrder,
      modelCalls: session.modelCalls,
    });
  }
}
