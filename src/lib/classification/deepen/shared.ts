import OpenAI from 'openai';
import { Config } from 'coze-coding-dev-sdk';

import { leafName } from '../source-path';
import { buildTimeline, describeTimeline } from '../minimal/evidence';
import { hasExtractedFacts, loadMinimalArchive, type MinimalDocument } from '../minimal/store';
import { decideStageWithModel } from '../llm-stage-decision';
import type { ModelCallDiagnostics } from '../chat-completions';
import { DEEPEN_TOOLS, runDeepenTool, type DeepenToolContext } from './tools';
import {
  DEEPEN_BUDGET,
  DEEPEN_MODEL,
  type DeepenOrchestrator,
  type DeepenParams,
  type DeepenResult,
  type DeepenStopReason,
  type DeepenToolCall,
  type DeepenTraceRound,
} from './types';

/**
 * 两种编排共用的一切：客户端、提示词、单轮模型调用、工具执行、预算收尾、结果装配。
 *
 * 拆出这一层的目的很具体：**让"手写循环"和"LangGraph"之间只剩控制流的差别。**
 * 工具、预算、提示词、判定器、结果结构全都一样，两者才谈得上对照——否则跑出来的差异
 * 说不清是编排方式带来的，还是别处顺手改了什么。
 *
 * 这也是 tools.ts 一行都不用改的原因：`DEEPEN_TOOLS` 是 OpenAI 格式的 JSON schema，
 * `runDeepenTool` 是纯派发函数，两者都不认识任何编排框架。
 */

function readFlag(name: string): boolean | undefined {
  const raw = globalThis.process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return undefined; // 认不出来的值当没设，不猜
}

/**
 * 深挖是否启用。**默认开启**，除非显式关掉。
 *
 * 原先是默认关闭、靠 ENABLE_DEEPEN_AGENT=true 打开。改掉的原因是那个开关的安全
 * 收益撑不起它的麻烦：深挖只读不写、不改任何文件的归档位置、而且必须用户右键点了
 * 才跑。默认关着挡住的不是风险，只是可用性。
 *
 * 真正的风险闸门不在这个开关上，在别处：
 * - 工具清单里没有任何写操作（tools.ts），模型改不了东西；
 * - 结论交回现有判定器，深挖自己不判阶段；
 * - 产出只是建议，归档照旧要人工确认。
 *
 * 要关掉用 DISABLE_DEEPEN_AGENT=true，或把 ENABLE_DEEPEN_AGENT 显式设成 false。
 * 两种写法都容忍大小写、首尾空格和 1/0/yes/no。
 */
export function isDeepenEnabled(): boolean {
  if (readFlag('DISABLE_DEEPEN_AGENT') === true) return false;
  const explicit = readFlag('ENABLE_DEEPEN_AGENT');
  if (explicit !== undefined) return explicit;
  return true; // 默认开
}

/** 当前状态的人话说明，只在被关掉时用得上。 */
export function describeDeepenFlag(): string {
  if (readFlag('DISABLE_DEEPEN_AGENT') === true) {
    return '被 DISABLE_DEEPEN_AGENT 显式关闭了';
  }
  if (readFlag('ENABLE_DEEPEN_AGENT') === false) {
    return '被 ENABLE_DEEPEN_AGENT=false 显式关闭了';
  }
  return '默认开启';
}

/**
 * 默认编排。缺省是手写循环——**它是线上跑过的那套，改默认值要有实测依据，不能因为
 * 另一种写法更时髦就换。** 用 DEEPEN_ORCHESTRATOR=graph 切到 LangGraph。
 */
export function defaultOrchestrator(): DeepenOrchestrator {
  return globalThis.process.env.DEEPEN_ORCHESTRATOR?.trim().toLowerCase() === 'graph'
    ? 'graph'
    : 'loop';
}

// 与 read-document-content.ts 里那行 [OCR] 同样的用意：启动时打一次实际状态，
// 省得开没开、跑的是哪套编排只能靠猜。
console.log(
  `[DEEPEN] enabled=${isDeepenEnabled()}（${describeDeepenFlag()}）orchestrator=${defaultOrchestrator()}`
);

/**
 * 指向现有网关的客户端。
 *
 * 用 `openai` 这个包不代表请求发给 OpenAI——baseURL 指到哪就发到哪，这里指的是
 * Coze 网关，模型是豆包。用它是因为它替我们把**流式分片吐出来的 tool_calls 拼回
 * 完整 JSON**，那是手写最容易出错的一段。
 */
export function createGatewayClient(): OpenAI {
  const config = new Config({ timeout: 120_000 });
  if (!config.modelBaseUrl) {
    throw new Error('缺少 COZE_INTEGRATION_MODEL_BASE_URL，无法调用模型');
  }
  if (!config.apiKey) {
    throw new Error('缺少 COZE_WORKLOAD_IDENTITY_API_KEY，无法调用模型');
  }
  return new OpenAI({
    baseURL: config.modelBaseUrl.replace(/\/$/, ''),
    apiKey: config.apiKey,
    timeout: 120_000,
    defaultHeaders: { 'X-Client-Sdk': 'coze-coding-dev-sdk-typescript/0.3.0' },
  });
}

export function buildSystemPrompt(): string {
  return `你在协助整理一个投资项目的档案。当前任务：为某一份文件收集足以判断它属于哪个业务阶段的证据。

你的产出是**证据**，不是结论——阶段由另一个环节判定。你要做的是把能定方向的事实找齐。

工作方式：需要事实就调工具去取，不要凭空猜测文件内容。

**读文件要调视觉模型读扫描件，慢且花钱，最多只能读 ${DEEPEN_BUDGET.maxExtracts} 份。** 项目里没读过的文件通常远不止这个数，所以必须挑——挑真正能定结论的读，不要把次数花在看起来相关但定不了事的文件上。

两条硬规矩：

1. **不许凭文件类型猜阶段。** "章程通常属于投资实施"这类结论不作数——要指着文件里的具体数字或措辞说话。
2. **打印时间、OA 流程截图里的审批时间不是文件的形成时间**，不能当作这份文件的日期证据。同一份文件里可能同时记着申请时间和十几天后的审批日志，别把流程日志当成文件时点。

取证够了就停下来，用一段话说明你找到了什么、它指向什么。

如果读完仍然定不了，就明说定不了，并说清**还缺一份记载什么的文件**——"证据不足"是废话，"缺一份记载注册资本变更的股东会决议"才是能派活给人的信息。`;
}

export function buildUserPrompt(targetName: string): string {
  return `请为《${targetName}》收集判断其业务阶段所需的证据。

先弄清楚项目里有哪些文件，再决定读哪几份。`;
}

/** 预算触顶时追加的那句话。让模型收尾并说清缺什么，而不是被硬切断。 */
export const BUDGET_WARNING =
  '读取预算已用尽，不能再读新文件了。请基于已有事实给出你的取证结论；如果仍然定不了，说清还缺一份记载什么的文件。';

/**
 * 可注入的外部依赖。**只为测试存在**，生产调用不传，走默认实现。
 *
 * 循环本身（预算、轮次、轨迹、停止原因）是这条链路唯一的自有逻辑，也是唯一会出
 * 微妙错误的地方。它却夹在三个要联网的东西中间——模型网关、S3 档案、判定器。
 * 不留这个接缝，这段逻辑就只能靠线上跑真实文件来验，太贵也太慢。
 *
 * 两种编排共用同一个接缝，所以同一份假模型能把两者都测一遍。
 */
export interface DeepenDeps {
  createClient: () => OpenAI;
  loadArchive: typeof loadMinimalArchive;
  decide: typeof decideStageWithModel;
}

export const defaultDeps: DeepenDeps = {
  createClient: createGatewayClient,
  loadArchive: loadMinimalArchive,
  decide: decideStageWithModel,
};

/** 一次深挖的全部可变状态。两种编排都在它上面工作。 */
export interface DeepenSession {
  startedAt: number;
  trace: DeepenTraceRound[];
  modelCalls: ModelCallDiagnostics[];
  context: DeepenToolContext;
  gatheredOrder: Array<{ sourcePath: string; round: number }>;
  target: MinimalDocument;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  client: OpenAI;
  budgetWarned: boolean;
}

export function emptyResult(
  params: DeepenParams,
  orchestrator: DeepenOrchestrator,
  startedAt: number,
  stopReason: DeepenStopReason,
  extra: Partial<DeepenResult> = {}
): DeepenResult {
  return {
    sourcePath: params.sourcePath,
    orchestrator,
    decision: null,
    gatheredFacts: [],
    stopReason,
    closingNote: '',
    trace: [],
    extractCount: 0,
    roundCount: 0,
    totalDurationMs: Date.now() - startedAt,
    modelCalls: [],
    ...extra,
  };
}

/**
 * 开一次深挖：读档案、找目标文件、建上下文和初始消息。
 *
 * 目标文件不在档案里时不进循环——白跑十二轮也变不出这份文件。
 */
export async function openSession(
  params: DeepenParams,
  deps: DeepenDeps,
  startedAt: number
): Promise<{ session: DeepenSession } | { error: string }> {
  const archive = await deps.loadArchive(params.projectId);
  const target = archive.documents.find(
    document => document.sourcePath === params.sourcePath
  );
  if (!target) {
    return { error: `项目档案里没有这份文件：${params.sourcePath}` };
  }

  const modelCalls: ModelCallDiagnostics[] = [];
  const context: DeepenToolContext = {
    projectId: params.projectId,
    projectName: params.projectName,
    targetSourcePath: params.sourcePath,
    // 复制一份，深挖过程中的更新不污染调用方手上的档案。
    documents: archive.documents.map(document => ({ ...document })),
    customHeaders: params.customHeaders ?? {},
    extractCount: 0,
    gathered: new Map(),
    modelCalls,
  };

  return {
    session: {
      startedAt,
      trace: [],
      modelCalls,
      context,
      gatheredOrder: [],
      target,
      client: deps.createClient(),
      budgetWarned: false,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(leafName(params.sourcePath)) },
      ],
    },
  };
}

export interface ModelTurn {
  message: OpenAI.Chat.ChatCompletionMessage;
  finishReason: string | null;
  /** 模型没要工具 = 这是最终答复。 */
  isFinal: boolean;
}

/** 问模型一次。两种编排的"想"都走这里。 */
export async function callModel(session: DeepenSession): Promise<ModelTurn | null> {
  // 必须走流式：网关一律以 SSE 返回，即使没要求流式。
  // finalChatCompletion() 会把分片拼回完整消息，含 tool_calls。
  const stream = session.client.chat.completions.stream({
    model: DEEPEN_MODEL,
    messages: session.messages,
    tools: DEEPEN_TOOLS,
    tool_choice: 'auto',
    max_tokens: 1_200,
    // 网关的非标字段，与主链路的 invokeChatCompletion 保持一致。SDK 的类型
    // 放行未知字段，请求体原样序列化后照常发出去。
    thinking: { type: 'disabled' },
  });

  const completion = await stream.finalChatCompletion();
  const choice = completion.choices?.[0];
  const message = choice?.message;
  if (!message) return null;

  session.messages.push(message);
  return {
    message,
    finishReason: choice?.finish_reason ?? null,
    isFinal: (message.tool_calls ?? []).length === 0,
  };
}

/** 执行这一轮模型点名的工具。两种编排的"做"都走这里。 */
export async function runToolCalls(
  session: DeepenSession,
  message: OpenAI.Chat.ChatCompletionMessage,
  round: number
): Promise<DeepenToolCall[]> {
  const toolCalls: DeepenToolCall[] = [];

  for (const call of message.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    const toolStartedAt = Date.now();
    const outcome = await runDeepenTool(
      call.function.name,
      call.function.arguments ?? '',
      session.context
    );
    if (call.function.name === 'extract_document_facts' && !outcome.isError) {
      const justRead = [...session.context.gathered.keys()].filter(
        key => !session.gatheredOrder.some(item => item.sourcePath === key)
      );
      for (const key of justRead) session.gatheredOrder.push({ sourcePath: key, round });
    }
    toolCalls.push({
      round,
      tool: call.function.name,
      rawArguments: call.function.arguments ?? '',
      resultBrief: outcome.brief,
      durationMs: Date.now() - toolStartedAt,
      isError: outcome.isError,
    });
    session.messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: outcome.content,
    });
  }

  return toolCalls;
}

/**
 * 读取预算触顶时追加收尾提示，只追加一次。
 *
 * 这道闸门和 tools.ts 里那道是故意重复的：**凡是"禁止模型做某事"的约束，都不能只
 * 写在指令里。** 工具层那道保证第 4 次读取一定被拒；这道保证模型知道该收尾了。
 */
export function maybeWarnBudget(session: DeepenSession): void {
  if (session.budgetWarned) return;
  if (session.context.extractCount < DEEPEN_BUDGET.maxExtracts) return;
  session.budgetWarned = true;
  session.messages.push({ role: 'user', content: BUDGET_WARNING });
}

/** 墙钟是否已经超了。 */
export function isTimedOut(session: DeepenSession): boolean {
  return Date.now() - session.startedAt > DEEPEN_BUDGET.wallClockMs;
}

/**
 * 收尾：把凑齐的事实交回判定器，装配结果。
 *
 * **深挖到此为止，阶段不是这里判的。** agent 改变的只有一件事：`relatedDocuments`
 * 里现在带着它主动读出来的新事实。同一个判定器、同一份文件，唯一变量就是事实的多寡
 * ——这样评测才能干净地做减法。
 */
export async function closeSession(
  params: DeepenParams,
  deps: DeepenDeps,
  session: DeepenSession,
  orchestrator: DeepenOrchestrator,
  stopReason: DeepenStopReason,
  closingNote: string,
  round: number
): Promise<DeepenResult> {
  const current =
    session.context.documents.find(
      document => document.sourcePath === params.sourcePath
    ) ?? session.target;
  const others = session.context.documents.filter(
    document => document.sourcePath !== params.sourcePath
  );

  const decided = await deps.decide({
    sourcePath: params.sourcePath,
    facts: current.facts,
    projectName: params.projectName,
    relatedDocuments: others.filter(hasExtractedFacts).map(document => ({
      sourcePath: document.sourcePath,
      facts: document.facts,
    })),
    timeline: describeTimeline(buildTimeline(session.context.documents), {
      showStage: true,
    }),
    namingHint: params.namingHint,
    projectNotes: params.projectNotes,
    customHeaders: params.customHeaders ?? {},
  });
  if (decided.modelCall) session.modelCalls.push(decided.modelCall);

  return {
    sourcePath: params.sourcePath,
    orchestrator,
    decision: decided.decision
      ? {
          stage: decided.decision.businessStage,
          folder: decided.decision.selectedFolder,
          reasoning: decided.decision.reasoning,
          evidence: decided.decision.evidence,
          contradictions: decided.decision.contradictions,
          requiresHumanReview: decided.decision.requiresHumanReview,
        }
      : null,
    gatheredFacts: session.gatheredOrder,
    stopReason,
    closingNote,
    trace: session.trace,
    extractCount: session.context.extractCount,
    roundCount: round,
    totalDurationMs: Date.now() - session.startedAt,
    modelCalls: session.modelCalls,
    error: decided.error,
  };
}
