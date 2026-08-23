import type OpenAI from 'openai';

import { runDeepenLoop } from './loop';
import {
  callModel,
  closeSession,
  emptyResult,
  isTimedOut,
  maybeWarnBudget,
  openSession,
  runToolCalls,
  type DeepenDeps,
  type DeepenSession,
  type LangGraphRuntime,
} from './shared';
import {
  DEEPEN_BUDGET,
  type DeepenParams,
  type DeepenResult,
  type DeepenStopReason,
} from './types';

/**
 * 编排方式二：LangGraph 状态机。
 *
 * ```
 *   START → agent ─(要工具)→ tools ─(预算没到)→ agent
 *             │                  └─(预算到了)──→ END
 *             └─(不要工具 / 出错)───────────────→ END
 * ```
 *
 * 和 loop.ts 是同一件事的两种写法：工具、预算、提示词、判定器、结果结构全部共用，
 * **只有控制流不同**。所以 tests/deepen-agent.test.ts 用同一份假模型、同一组断言
 * 把两者各跑一遍——编排换掉而行为不变，这个等价关系才是留两套的意义。
 *
 * 两点值得说明：
 *
 * **一、没用现成的 ToolNode。** ToolNode 不管预算，而"这份文件值不值得读"是这条
 * 链路唯一在做的决策。预算判定必须和工具执行在同一个节点里——触顶时才能就地把收尾
 * 提示追加进上下文，让模型说清还缺什么，而不是被硬切断。
 *
 * **二、messages 不在图状态里，在 session 里。** 更 LangGraph 的写法是把消息数组
 * 放进 Annotation、用 reducer 累加。这里没这么做，是因为消息的追加逻辑
 * （工具结果怎么塞回去、预算提示什么时候追加）要和手写循环**逐字节共用**，否则两套
 * 编排就不是在比控制流，而是在比两份各自写的消息拼装代码了。图状态只持有真正驱动
 * 路由的那几个值。
 *
 * LangGraph 依赖是**动态引入**的：默认走 loop 时这个包根本不会被加载，包体积和冷启动
 * 都不受影响。
 */

/**
 * 默认的 LangGraph 加载器。
 *
 * 动态 import 而不是顶部静态 import：默认走手写循环时这个包根本不会被加载。
 * 配合 next.config.ts 里的 serverExternalPackages，它也不进构建产物。
 */
async function loadLangGraph(): Promise<LangGraphRuntime> {
  return import('@langchain/langgraph');
}

/** 图节点之间传递的、驱动路由的那几个值。 */
interface GraphState {
  round: number;
  stopReason: DeepenStopReason | null;
  closingNote: string;
}

/** 一轮里跨节点传递的临时数据。放在闭包里，不进图状态——它们不参与路由。 */
interface PendingTurn {
  message: OpenAI.Chat.ChatCompletionMessage;
  finishReason: string | null;
  startedAt: number;
}

export async function runDeepenGraph(
  params: DeepenParams,
  deps: DeepenDeps
): Promise<DeepenResult> {
  const startedAt = Date.now();

  const opened = await openSession(params, deps, startedAt);
  if ('error' in opened) {
    return emptyResult(params, 'graph', startedAt, 'error', { error: opened.error });
  }
  const session: DeepenSession = opened.session;

  /**
   * 取 LangGraph 运行时。**拿不到就回退到手写循环，绝不让整条深挖挂掉。**
   *
   * 这不是防御性编程的洁癖，是上线第一天踩出来的：这个包是后加的，平台上的依赖只在
   * 构建步骤安装，热更新不重装——结果第二套编排把整个页面带崩了。可选的对照实验
   * 不该有这种权力。
   *
   * 回退时把原因写进 error 一并返回，界面上看得见。悄悄换一套跑比报错更糟：用户
   * 明明点的是 LangGraph，拿到的却是另一套的结果而毫不知情。
   */
  let runtime: LangGraphRuntime;
  try {
    runtime = await (deps.loadGraphRuntime ?? loadLangGraph)();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = await runDeepenLoop(params, deps);
    return {
      ...fallback,
      error: `LangGraph 编排不可用，已回退到手写循环。原因：${reason}。依赖只在构建步骤安装，重新构建一次即可。`,
    };
  }
  const { Annotation, END, START, StateGraph } = runtime;

  const State = Annotation.Root({
    round: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
    stopReason: Annotation<DeepenStopReason | null>({
      reducer: (_, next) => next,
      default: () => null,
    }),
    closingNote: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  });

  let pending: PendingTurn | null = null;
  let gatewayFailed = false;

  const agentNode = async (state: GraphState) => {
    const round = state.round + 1;
    const roundStartedAt = Date.now();

    const turn = await callModel(session);
    if (!turn) {
      gatewayFailed = true;
      session.trace.push({
        round,
        message: '',
        toolCalls: [],
        durationMs: Date.now() - roundStartedAt,
        finishReason: null,
      });
      return { round, stopReason: 'error' as DeepenStopReason };
    }

    // 没有工具调用 = 这是最终答复，取证结束。
    if (turn.isFinal) {
      const closingNote = turn.message.content?.trim() ?? '';
      session.trace.push({
        round,
        message: closingNote,
        toolCalls: [],
        durationMs: Date.now() - roundStartedAt,
        finishReason: turn.finishReason,
      });
      return { round, stopReason: 'completed' as DeepenStopReason, closingNote };
    }

    pending = {
      message: turn.message,
      finishReason: turn.finishReason,
      startedAt: roundStartedAt,
    };
    return { round };
  };

  const toolsNode = async (state: GraphState) => {
    const turn = pending;
    pending = null;
    if (!turn) return {};

    const toolCalls = await runToolCalls(session, turn.message, state.round);
    session.trace.push({
      round: state.round,
      message: turn.message.content?.trim() ?? '',
      toolCalls,
      durationMs: Date.now() - turn.startedAt,
      finishReason: turn.finishReason,
    });

    // 预算触顶时追加一句，让它收尾并说清缺什么，而不是被硬切断。
    maybeWarnBudget(session);
    return {};
  };

  const afterAgent = (state: GraphState): 'tools' | typeof END =>
    state.stopReason ? END : 'tools';

  /**
   * 预算判定。顺序和手写循环里那个 while 头部严格一致：**先看轮数，再看墙钟。**
   * 反过来的话，最后一轮同时超时的情况会被记成 timeout 而不是 round_budget——
   * 停止原因是评测要分组统计的字段，两套编排在这里不能有分歧。
   */
  const afterTools = (state: GraphState): 'agent' | typeof END => {
    if (state.round >= DEEPEN_BUDGET.maxRounds) return END;
    if (isTimedOut(session)) return END;
    return 'agent';
  };

  const graph = new StateGraph(State)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', afterAgent, ['tools', END])
    .addConditionalEdges('tools', afterTools, ['agent', END])
    .compile();

  try {
    const final = (await graph.invoke(
      {},
      // 图的递归上限必须**宽于**业务预算，否则先触发的是框架的保护而不是我们的预算，
      // 停止原因就再也分不清是"读够了"还是"被框架掐断"。每轮最多两个节点。
      { recursionLimit: DEEPEN_BUDGET.maxRounds * 2 + 10 }
    )) as GraphState;

    if (gatewayFailed) {
      return emptyResult(params, 'graph', startedAt, 'error', {
        error: '网关没有返回消息内容',
        trace: session.trace,
        extractCount: session.context.extractCount,
        roundCount: final.round,
        modelCalls: session.modelCalls,
      });
    }

    // 收尾判定与 loop.ts 逐条对齐。
    let stopReason: DeepenStopReason = final.stopReason ?? 'round_budget';
    let closingNote = final.closingNote;

    if (!final.stopReason && isTimedOut(session) && final.round < DEEPEN_BUDGET.maxRounds) {
      stopReason = 'timeout';
    }
    if (stopReason === 'round_budget') {
      closingNote = '轮数用尽，未给出取证结论。';
    }
    if (stopReason === 'timeout') {
      closingNote = '超时中断，未给出取证结论。';
    }
    if (session.budgetWarned && stopReason === 'completed') {
      stopReason = 'extract_budget';
    }

    return closeSession(
      params,
      deps,
      session,
      'graph',
      stopReason,
      closingNote,
      final.round
    );
  } catch (error) {
    return emptyResult(params, 'graph', startedAt, 'error', {
      error: error instanceof Error ? error.message : String(error),
      trace: session.trace,
      extractCount: session.context.extractCount,
      roundCount: session.trace.length,
      gatheredFacts: session.gatheredOrder,
      modelCalls: session.modelCalls,
    });
  }
}
