import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import { createTools, leafName, type ToolContext } from './tools.js';
import type { AgentModel } from './model.js';
import { BUDGET, STAGE_LABEL, type ProjectDoc, type StopReason, type ToolCallRecord } from './types.js';
import { decideStage, type StageDecision } from './decide.js';

/**
 * 取证 Agent 的 LangGraph 实现。
 *
 * ```
 *   START → agent ─(有工具调用)→ tools ─(预算没到)→ agent
 *             │                     └─(预算到了)──→ decide → END
 *             └─(没有工具调用)────────────────────→ decide → END
 * ```
 *
 * **循环就是 agent ⇄ tools 这条边。** 问模型 → 它要工具就执行、把结果塞回去 → 再问 →
 * 直到它不再要工具。剩下的都是预算、轨迹和边界。
 *
 * 三条边界：
 *
 * 1. **只取证，不判阶段。** 循环结束后把凑齐的事实交给 `decide` 节点，判断权只有一个
 *    出口。不这么做的话系统里会出现第二个判据来源——上一版架构失败正是判断权跑到了
 *    覆盖面最窄的组件手里。
 * 2. **只读不写。** 五个工具里没有任何写操作，深挖读到的新事实不写回项目档案。
 * 3. **预算是硬的。** 轮数 / 读取次数 / 墙钟三个上限，任一触顶立刻收敛，并要求模型
 *    说清**还缺一份记载什么的文件**——"证据不足"是废话，那句话才是能派活给人的信息。
 *
 * 为什么执行工具的节点是自己写的、没用现成的 ToolNode：**ToolNode 不管预算。**
 * 而"这份值不值得读"正是这条链路唯一在做的决策，预算判定必须和工具执行在同一个地方，
 * 触顶时才能就地把收尾提示追加进上下文，而不是把模型硬切断。
 */

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** 已经问过模型几次。 */
  round: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  stopReason: Annotation<StopReason>({
    reducer: (_, next) => next,
    default: () => 'round_budget',
  }),
  closingNote: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  /** 收尾提示只追加一次。 */
  budgetWarned: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  decision: Annotation<StageDecision | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;

function buildSystemPrompt(): string {
  return `你在协助整理一个投资项目的档案。当前任务：为某一份文件收集足以判断它属于哪个业务阶段的证据。

你的产出是**证据**，不是结论——阶段由另一个环节判定。你要做的是把能定方向的事实找齐。

工作方式：需要事实就调工具去取，不要凭空猜测文件内容。

**读文件要调视觉模型读扫描件，慢且花钱，最多只能读 ${BUDGET.maxExtracts} 份。** 项目里没读过的文件通常远不止这个数，所以必须挑——挑真正能定结论的读，不要把次数花在看起来相关但定不了事的文件上。

两条硬规矩：

1. **不许凭文件类型猜阶段。** "章程通常属于投资实施"这类结论不作数——要指着文件里的具体数字或措辞说话。
2. **打印时间、OA 流程截图里的审批时间不是文件的形成时间**，不能当作这份文件的日期证据。

取证够了就停下来，用一段话说明你找到了什么、它指向什么。

如果读完仍然定不了，就明说定不了，并说清**还缺一份记载什么的文件**——"证据不足"是废话，"缺一份记载注册资本变更的股东会决议"才是能派活给人的信息。`;
}

export interface RunOptions {
  targetSourcePath: string;
  documents: ProjectDoc[];
  model: AgentModel;
  extractLatencyMs?: number;
  /** 测试里可以调小，用来验证超时那条边。 */
  wallClockMs?: number;
}

export interface RunResult {
  stopReason: StopReason;
  closingNote: string;
  roundCount: number;
  extractCount: number;
  gathered: string[];
  records: ToolCallRecord[];
  decision: StageDecision | null;
  totalDurationMs: number;
}

export async function runAgent(options: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const wallClockMs = options.wallClockMs ?? BUDGET.wallClockMs;

  const ctx: ToolContext = {
    targetSourcePath: options.targetSourcePath,
    // 复制一份，取证过程中的更新不污染调用方手上的档案。
    documents: options.documents.map(d => ({ ...d, facts: { ...d.facts } })),
    extractCount: 0,
    gathered: [],
    records: [],
    extractLatencyMs: options.extractLatencyMs ?? 0,
  };
  const tools = createTools(ctx);
  const toolsByName = new Map<string, StructuredToolInterface>(
    tools.map(t => [t.name, t as StructuredToolInterface])
  );

  // ---- 节点 ----

  const agentNode = async (state: AgentStateType) => {
    const reply = await options.model.invoke(state.messages);
    return { messages: [reply], round: state.round + 1 };
  };

  const toolsNode = async (state: AgentStateType) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const out: BaseMessage[] = [];

    for (const call of last.tool_calls ?? []) {
      const tool = toolsByName.get(call.name);
      const toolStartedAt = Date.now();
      let content: string;
      let isError = false;
      if (!tool) {
        content = JSON.stringify({ error: `未知工具：${call.name}` });
        isError = true;
      } else {
        try {
          content = String(await tool.invoke(call.args));
          isError = content.includes('"error"');
        } catch (error) {
          content = JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          });
          isError = true;
        }
      }
      ctx.records.push({
        round: state.round,
        tool: call.name,
        args: call.args,
        brief: brief(content),
        isError,
        durationMs: Date.now() - toolStartedAt,
      });
      out.push(
        new ToolMessage({
          content,
          tool_call_id: call.id ?? `${call.name}-${ctx.records.length}`,
          name: call.name,
        })
      );
    }

    // 预算触顶时追加一句，让它收尾并说清缺什么，而不是被硬切断。
    let budgetWarned = state.budgetWarned;
    if (!budgetWarned && ctx.extractCount >= BUDGET.maxExtracts) {
      budgetWarned = true;
      out.push(
        new HumanMessage(
          '读取预算已用尽，不能再读新文件了。请基于已有事实给出你的取证结论；如果仍然定不了，说清还缺一份记载什么的文件。'
        )
      );
    }
    return { messages: out, budgetWarned };
  };

  /**
   * 交回判定器。
   *
   * **取证到此为止，阶段不是 agent 判的。** agent 改变的只有一件事：交给判定器的
   * 事实变多了。同一个判定器、同一份文件，唯一变量是事实的多寡——这样才能干净地
   * 做减法评测："不给它取证，同样这份文件判成什么？"
   */
  const decideNode = async (state: AgentStateType) => {
    const target =
      ctx.documents.find(d => d.sourcePath === options.targetSourcePath) ?? null;
    const others = ctx.documents.filter(d => d.sourcePath !== options.targetSourcePath);
    return { decision: target ? decideStage(target, others) : null };
  };

  // ---- 边 ----

  const afterAgent = (state: AgentStateType): 'tools' | 'decide' => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    if (!last.tool_calls || last.tool_calls.length === 0) return 'decide';
    return 'tools';
  };

  const afterTools = (state: AgentStateType): 'agent' | 'decide' => {
    if (Date.now() - startedAt > wallClockMs) return 'decide';
    if (state.round >= BUDGET.maxRounds) return 'decide';
    return 'agent';
  };

  const graph = new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addNode('decide', decideNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', afterAgent, { tools: 'tools', decide: 'decide' })
    .addConditionalEdges('tools', afterTools, { agent: 'agent', decide: 'decide' })
    .addEdge('decide', END)
    .compile();

  const final = (await graph.invoke(
    {
      messages: [
        new SystemMessage(buildSystemPrompt()),
        new HumanMessage(
          `请为《${leafName(options.targetSourcePath)}》收集判断其业务阶段所需的证据。\n\n先弄清楚项目里有哪些文件，再决定读哪几份。`
        ),
      ],
    },
    { recursionLimit: BUDGET.maxRounds * 2 + 10 }
  )) as AgentStateType;

  // 停止原因要在图跑完之后定：区分"想清楚了"和"被预算掐断"，评测时这两者不能混。
  const lastAi = [...final.messages].reverse().find(m => m._getType() === 'ai') as
    | AIMessage
    | undefined;
  const modelStoppedOnItsOwn = !lastAi?.tool_calls || lastAi.tool_calls.length === 0;

  let stopReason: StopReason;
  let closingNote = '';
  if (Date.now() - startedAt > wallClockMs) {
    stopReason = 'timeout';
    closingNote = '超时中断，未给出取证结论。';
  } else if (!modelStoppedOnItsOwn) {
    stopReason = 'round_budget';
    closingNote = '轮数用尽，未给出取证结论。';
  } else if (final.budgetWarned) {
    stopReason = 'extract_budget';
    closingNote = String(lastAi?.content ?? '');
  } else {
    stopReason = 'completed';
    closingNote = String(lastAi?.content ?? '');
  }

  return {
    stopReason,
    closingNote,
    roundCount: final.round,
    extractCount: ctx.extractCount,
    gathered: ctx.gathered,
    records: ctx.records,
    decision: final.decision,
    totalDurationMs: Date.now() - startedAt,
  };
}

function brief(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
}

export { STAGE_LABEL };
