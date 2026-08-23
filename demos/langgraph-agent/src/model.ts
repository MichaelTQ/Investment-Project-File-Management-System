import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { StructuredToolInterface } from '@langchain/core/tools';

/**
 * 编排用的"大脑"。
 *
 * 抽成接口是为了让**循环本身可以离线跑**。循环里唯一会出微妙错误的地方就是预算、
 * 轮次、轨迹和停止原因，它却夹在模型网关中间；不留这个接缝，这段逻辑就只能靠联网
 * 跑真实文件来验，太贵也太慢。生产代码里同样的接缝叫 `DeepenDeps`。
 */
export interface AgentModel {
  readonly label: string;
  invoke(messages: BaseMessage[]): Promise<AIMessage>;
}

let callCounter = 0;
const nextId = () => `call_${(callCounter += 1)}`;

function toolNamesUsed(messages: BaseMessage[]): string[] {
  return messages
    .filter((m): m is ToolMessage => m._getType() === 'tool')
    .map(m => String(m.name ?? ''));
}

/** 预算触顶时图会追加一条 user 消息，脚本模型据此收尾。 */
function budgetWarned(messages: BaseMessage[]): boolean {
  return messages.filter(m => m._getType() === 'human').length > 1;
}

function call(name: string, args: Record<string, unknown> = {}): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ name, args, id: nextId() }],
  });
}

/**
 * 离线脚本模型：把真实模型在这个案例上的动作序列固定下来。
 *
 * **它不是在假装智能，它是个测试替身。** 图的结构、工具执行、预算判定、停止原因
 * 分类全都是真的跑；只有"下一步选哪个工具"被换成了确定性序列，这样每次跑结果一样，
 * 循环逻辑本身才测得准。要看真模型自己挑文件，跑 `--model=gateway`。
 */
export function scriptedModel(scenario: 'focused' | 'greedy'): AgentModel {
  const plan: Array<() => AIMessage> =
    scenario === 'focused'
      ? [
          () => call('list_project_documents'),
          () => call('match_naming_spec', { file_name: '公司章程-B.pdf' }),
          () => call('extract_document_facts', { file_name: '公司章程-B.pdf' }),
          () => call('get_project_timeline'),
          () => call('extract_document_facts', { file_name: '股东会决议.pdf' }),
        ]
      : [
          () => call('list_project_documents'),
          () => call('extract_document_facts', { file_name: '公司章程-B.pdf' }),
          () => call('extract_document_facts', { file_name: '法务尽调报告.pdf' }),
          () => call('extract_document_facts', { file_name: '电子回单.png' }),
          () => call('extract_document_facts', { file_name: '公司章程-A.pdf' }),
        ];

  const closing =
    scenario === 'focused'
      ? new AIMessage(
          '取证完成。《公司章程-B》记载注册资本 1304.027 万元，且股东名册里已经有甲基金、乙基金；' +
            '《股东会决议》（2026-04-10）记载注册资本由 1173.624 万元变更为 1304.027 万元。' +
            '章程记的是变更**之后**的值，且落款日 2026-04-15 晚于决议日——它形成于这笔交易完成之后。'
        )
      : new AIMessage(
          '读取预算已用尽，仍定不了。已读的三份里没有一份记载注册资本的变更过程：' +
            '《法务尽调报告》和《电子回单》都只记了单点状态。' +
            '还缺一份**记载注册资本由 A 变更为 B 的股东会决议**，有了它才能确定章程在变更的哪一侧。'
        );

  return {
    label: `scripted:${scenario}`,
    async invoke(messages) {
      if (budgetWarned(messages)) return closing;
      const step = toolNamesUsed(messages).length;
      return step < plan.length ? plan[step]() : closing;
    },
  };
}

/**
 * 真模型：任何 OpenAI 兼容网关。
 *
 * 用 `openai` 这个包不代表请求发给 OpenAI——baseURL 指到哪就发到哪。生产环境这里
 * 指的是自建网关、跑的是国产模型。用它是因为它替我们把**流式分片吐出来的 tool_calls
 * 拼回完整 JSON**，那是手写最容易出错的一段。
 */
export async function gatewayModel(tools: StructuredToolInterface[]): Promise<AgentModel> {
  const { default: OpenAI } = await import('openai');
  const baseURL = process.env.MODEL_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.MODEL_API_KEY;
  const model = process.env.MODEL_NAME?.trim() || 'gpt-4o-mini';
  if (!baseURL || !apiKey) {
    throw new Error(
      '缺少 MODEL_BASE_URL / MODEL_API_KEY。离线跑请去掉 --model=gateway。'
    );
  }
  const client = new OpenAI({ baseURL, apiKey, timeout: 120_000 });
  const openAITools = tools.map(t => convertToOpenAITool(t));

  return {
    label: `gateway:${model}`,
    async invoke(messages) {
      const payload = messages.map(m => {
        const type = m._getType();
        if (type === 'system') return { role: 'system' as const, content: String(m.content) };
        if (type === 'human') return { role: 'user' as const, content: String(m.content) };
        if (type === 'tool') {
          const tm = m as ToolMessage;
          return {
            role: 'tool' as const,
            tool_call_id: tm.tool_call_id,
            content: String(tm.content),
          };
        }
        const am = m as AIMessage;
        return {
          role: 'assistant' as const,
          content: String(am.content ?? ''),
          ...(am.tool_calls && am.tool_calls.length > 0
            ? {
                tool_calls: am.tool_calls.map(tc => ({
                  id: tc.id ?? nextId(),
                  type: 'function' as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        };
      });

      const completion = await client.chat.completions.create({
        model,
        messages: payload as never,
        tools: openAITools as never,
        tool_choice: 'auto',
        max_tokens: 1_200,
      });
      const message = completion.choices?.[0]?.message;
      if (!message) throw new Error('网关没有返回消息内容');

      return new AIMessage({
        content: message.content ?? '',
        tool_calls: (message.tool_calls ?? [])
          .filter(tc => tc.type === 'function')
          .map(tc => ({
            name: tc.function.name,
            args: safeParse(tc.function.arguments),
            id: tc.id,
          })),
      });
    },
  };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export { HumanMessage };
