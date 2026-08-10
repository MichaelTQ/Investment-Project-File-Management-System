import OpenAI from 'openai';
import { Config } from 'coze-coding-dev-sdk';

import { leafName } from '../source-path';
import { buildTimeline, describeTimeline } from '../minimal/evidence';
import { hasExtractedFacts, loadMinimalArchive } from '../minimal/store';
import { decideStageWithModel } from '../llm-stage-decision';
import type { ModelCallDiagnostics } from '../chat-completions';
import { DEEPEN_TOOLS, runDeepenTool, type DeepenToolContext } from './tools';
import {
  DEEPEN_BUDGET,
  DEEPEN_MODEL,
  type DeepenParams,
  type DeepenResult,
  type DeepenStopReason,
  type DeepenToolCall,
  type DeepenTraceRound,
} from './types';

/**
 * 深挖旁路：判不出来的时候，自己去查一轮再判。
 *
 * 这是整个项目里唯一一处真正的 agent——步数不定、路径由中间结果决定、终止条件自己判。
 * 主链路不是（步骤固定），已下线的那套 LangGraph 编排也不是（零模型调用）。
 *
 * **循环本身就是下面那三十行。** 问模型 → 它要工具就执行、把结果塞回去 → 再问 →
 * 直到它不再要工具。剩下的都是预算、轨迹和边界。
 *
 * 三条边界（见 docs/DEEPEN_AGENT_PLAN.md 第 3 节）：
 *
 * - **只取证，不判阶段。** 循环结束后把凑齐的事实交回 `decideStageWithModel`，
 *   判断权仍然只有一个出口。不这么做的话，系统里会出现第二个判据来源——
 *   上一次架构失败正是判断权跑到了覆盖面最窄的组件手里。
 * - **只读不写。** 深挖抽到的新事实不写回项目档案。
 * - **默认关闭。** ENABLE_DEEPEN_AGENT=true 才启用。
 */

/**
 * 深挖是否启用。
 *
 * **环境变量的值永远是字符串**，跟布尔值 `true` 比恒为 false，怎么设都不会生效。
 * 这里容忍常见写法：大小写、首尾空格、`1`/`yes`。变量可能来自 shell、平台面板或
 * `.env` 三个地方，写成 `TRUE` 或末尾多一个空格是常事，严格相等会让人对着一句
 * "未启用"排查半天，而问题只是一个空格。
 */
export function isDeepenEnabled(): boolean {
  const raw = globalThis.process.env.ENABLE_DEEPEN_AGENT?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** 服务端实际读到的原始值。用来把"没设"和"设错了"区分开。 */
export function describeDeepenFlag(): string {
  const raw = globalThis.process.env.ENABLE_DEEPEN_AGENT;
  if (raw === undefined) return '未设置——服务进程的环境里没有这个变量';
  return `已设置，服务端读到的值是 ${JSON.stringify(raw)}`;
}

// 与 read-document-content.ts 里那行 [OCR] 同样的用意：环境变量在服务进程里
// 到底是什么值，启动时打一次，省得改没改成只能靠猜。
console.log(
  `[DEEPEN] enabled=${isDeepenEnabled()} raw=${JSON.stringify(
    globalThis.process.env.ENABLE_DEEPEN_AGENT ?? null
  )}`
);

/**
 * 指向现有网关的客户端。
 *
 * 用 `openai` 这个包不代表请求发给 OpenAI——baseURL 指到哪就发到哪，这里指的是
 * Coze 网关，模型是豆包。用它是因为它替我们把**流式分片吐出来的 tool_calls 拼回
 * 完整 JSON**，那是手写最容易出错的一段。
 *
 * 主链路的 `invokeChatCompletion` 不动：它服务上传流程，没有工具调用的需求。
 */
function createGatewayClient(): OpenAI {
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

function buildSystemPrompt(): string {
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

function buildUserPrompt(targetName: string): string {
  return `请为《${targetName}》收集判断其业务阶段所需的证据。

先弄清楚项目里有哪些文件，再决定读哪几份。`;
}

/**
 * 可注入的外部依赖。**只为测试存在**，生产调用不传，走默认实现。
 *
 * 循环本身（预算、轮次、轨迹、停止原因）是这个模块唯一的自有逻辑，也是唯一会出
 * 微妙错误的地方。它却夹在三个要联网的东西中间——模型网关、S3 档案、判定器。
 * 不留这个接缝，这段逻辑就只能靠线上跑真实文件来验，太贵也太慢。
 */
export interface DeepenDeps {
  createClient: () => OpenAI;
  loadArchive: typeof loadMinimalArchive;
  decide: typeof decideStageWithModel;
}

const defaultDeps: DeepenDeps = {
  createClient: createGatewayClient,
  loadArchive: loadMinimalArchive,
  decide: decideStageWithModel,
};

export async function runDeepen(
  params: DeepenParams,
  deps: DeepenDeps = defaultDeps
): Promise<DeepenResult> {
  const startedAt = Date.now();
  const trace: DeepenTraceRound[] = [];
  const modelCalls: ModelCallDiagnostics[] = [];
  const customHeaders = params.customHeaders ?? {};

  const archive = await deps.loadArchive(params.projectId);
  const target = archive.documents.find(
    document => document.sourcePath === params.sourcePath
  );

  const baseResult = (
    stopReason: DeepenStopReason,
    extra: Partial<DeepenResult> = {}
  ): DeepenResult => ({
    sourcePath: params.sourcePath,
    decision: null,
    gatheredFacts: [],
    stopReason,
    closingNote: '',
    trace,
    extractCount: 0,
    roundCount: trace.length,
    totalDurationMs: Date.now() - startedAt,
    modelCalls,
    ...extra,
  });

  if (!target) {
    return baseResult('error', { error: `项目档案里没有这份文件：${params.sourcePath}` });
  }

  const context: DeepenToolContext = {
    projectId: params.projectId,
    projectName: params.projectName,
    targetSourcePath: params.sourcePath,
    // 复制一份，深挖过程中的更新不污染调用方手上的档案。
    documents: archive.documents.map(document => ({ ...document })),
    customHeaders,
    extractCount: 0,
    gathered: new Map(),
    modelCalls,
  };

  const gatheredOrder: Array<{ sourcePath: string; round: number }> = [];
  const client = deps.createClient();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(leafName(params.sourcePath)) },
  ];

  let stopReason: DeepenStopReason = 'round_budget';
  let closingNote = '';
  let round = 0;
  let budgetWarned = false;

  try {
    while (round < DEEPEN_BUDGET.maxRounds) {
      if (Date.now() - startedAt > DEEPEN_BUDGET.wallClockMs) {
        stopReason = 'timeout';
        break;
      }
      round += 1;
      const roundStartedAt = Date.now();

      // 必须走流式：网关一律以 SSE 返回，即使没要求流式。
      // finalChatCompletion() 会把分片拼回完整消息，含 tool_calls。
      const stream = client.chat.completions.stream({
        model: DEEPEN_MODEL,
        messages,
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
      if (!message) {
        stopReason = 'error';
        trace.push({
          round,
          message: '',
          toolCalls: [],
          durationMs: Date.now() - roundStartedAt,
          finishReason: choice?.finish_reason ?? null,
        });
        return baseResult('error', {
          error: '网关没有返回消息内容',
          extractCount: context.extractCount,
          roundCount: round,
        });
      }

      messages.push(message);
      const calls = message.tool_calls ?? [];
      const toolCalls: DeepenToolCall[] = [];

      // 没有工具调用 = 这是最终答复，取证结束。
      if (calls.length === 0) {
        closingNote = message.content?.trim() ?? '';
        stopReason = 'completed';
        trace.push({
          round,
          message: closingNote,
          toolCalls: [],
          durationMs: Date.now() - roundStartedAt,
          finishReason: choice.finish_reason ?? null,
        });
        break;
      }

      for (const call of calls) {
        if (call.type !== 'function') continue;
        const toolStartedAt = Date.now();
        const outcome = await runDeepenTool(
          call.function.name,
          call.function.arguments ?? '',
          context
        );
        if (call.function.name === 'extract_document_facts' && !outcome.isError) {
          const justRead = [...context.gathered.keys()].filter(
            key => !gatheredOrder.some(item => item.sourcePath === key)
          );
          for (const key of justRead) gatheredOrder.push({ sourcePath: key, round });
        }
        toolCalls.push({
          round,
          tool: call.function.name,
          rawArguments: call.function.arguments ?? '',
          resultBrief: outcome.brief,
          durationMs: Date.now() - toolStartedAt,
          isError: outcome.isError,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: outcome.content,
        });
      }

      trace.push({
        round,
        message: message.content?.trim() ?? '',
        toolCalls,
        durationMs: Date.now() - roundStartedAt,
        finishReason: choice.finish_reason ?? null,
      });

      // 预算触顶时追加一句，让它收尾并说清缺什么，而不是被硬切断。
      if (context.extractCount >= DEEPEN_BUDGET.maxExtracts && !budgetWarned) {
        budgetWarned = true;
        messages.push({
          role: 'user',
          content:
            '读取预算已用尽，不能再读新文件了。请基于已有事实给出你的取证结论；如果仍然定不了，说清还缺一份记载什么的文件。',
        });
      }
    }

    if (round >= DEEPEN_BUDGET.maxRounds && stopReason === 'round_budget') {
      closingNote = '轮数用尽，未给出取证结论。';
    }
    if (stopReason === 'timeout') {
      closingNote = '超时中断，未给出取证结论。';
    }
    if (budgetWarned && stopReason === 'completed') {
      stopReason = 'extract_budget';
    }

    /**
     * 交回判定器。
     *
     * **深挖到此为止，阶段不是这里判的。** agent 改变的只有一件事：`relatedDocuments`
     * 里现在带着它主动读出来的新事实。同一个判定器、同一份文件，唯一变量就是事实的多寡
     * ——这样第 8 节的评测才能干净地做减法。
     */
    const current =
      context.documents.find(
        document => document.sourcePath === params.sourcePath
      ) ?? target;
    const others = context.documents.filter(
      document => document.sourcePath !== params.sourcePath
    );

    const decided = await deps.decide({
      sourcePath: params.sourcePath,
      facts: current.facts,
      projectName: params.projectName,
      relatedDocuments: others
        .filter(hasExtractedFacts)
        .map(document => ({
          sourcePath: document.sourcePath,
          facts: document.facts,
        })),
      timeline: describeTimeline(buildTimeline(context.documents), {
        showStage: true,
      }),
      namingHint: params.namingHint,
      projectNotes: params.projectNotes,
      customHeaders,
    });
    if (decided.modelCall) modelCalls.push(decided.modelCall);

    return {
      sourcePath: params.sourcePath,
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
      gatheredFacts: gatheredOrder,
      stopReason,
      closingNote,
      trace,
      extractCount: context.extractCount,
      roundCount: round,
      totalDurationMs: Date.now() - startedAt,
      modelCalls,
      error: decided.error,
    };
  } catch (error) {
    return baseResult('error', {
      error: error instanceof Error ? error.message : String(error),
      extractCount: context.extractCount,
      roundCount: round,
      gatheredFacts: gatheredOrder,
    });
  }
}
