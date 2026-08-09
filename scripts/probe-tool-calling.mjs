#!/usr/bin/env node
/**
 * 探测当前网关的模型支不支持 function calling（工具调用）。
 *
 * 这是"深挖 Agent"方案的第一块地基。整个方案成立的前提只有一条：
 * **模型能不能主动开口要工具。** 能，后面的循环、预算、评测才有意义；
 * 不能，方案作废，及早知道比写完再发现好。
 *
 * 与 probe-model.mjs 的分工：那个探"模型 ID 存不存在"，这个探"存在的模型会不会调工具"。
 *
 * 用法：
 *   node scripts/probe-tool-calling.mjs                  # 用默认模型
 *   node scripts/probe-tool-calling.mjs 模型ID            # 指定模型
 *
 * 需要环境变量 COZE_INTEGRATION_MODEL_BASE_URL 和 COZE_WORKLOAD_IDENTITY_API_KEY，
 * 也就是应用跑起来时用的那两个。
 */

import OpenAI from 'openai';

const baseUrl = process.env.COZE_INTEGRATION_MODEL_BASE_URL;
const apiKey = process.env.COZE_WORKLOAD_IDENTITY_API_KEY;

if (!baseUrl || !apiKey) {
  console.error(
    '缺少 COZE_INTEGRATION_MODEL_BASE_URL 或 COZE_WORKLOAD_IDENTITY_API_KEY。\n' +
      '请在应用能正常调用模型的那个环境里运行本脚本。'
  );
  process.exit(1);
}

const model = process.argv[2]?.trim() || 'doubao-seed-2-0-pro-260215';

/**
 * 用 openai 这个包，不代表请求会发给 OpenAI。
 *
 * baseURL 指到哪它就发到哪——这里指的是 Coze 网关，模型是豆包。这个包的作用是
 * 替我们拼请求、解析 SSE、把分片吐出来的 tool_calls 拼回完整的 JSON。最后那件事
 * 是手写时最容易出错的一段：工具名和参数是一个字符一个字符流式返回的，要按 index
 * 归并。SDK 做掉了。
 */
const client = new OpenAI({
  baseURL: baseUrl.replace(/\/$/, ''),
  apiKey,
  timeout: 120_000,
  defaultHeaders: {
    // 与 src/lib/classification/chat-completions.ts 保持一致，网关认这个头。
    'X-Client-Sdk': 'coze-coding-dev-sdk-typescript/0.3.0',
  },
});

/**
 * 只挂一个工具，而且是最便宜的那个：列出项目里有哪些文件。
 *
 * 这里刻意用假数据。本次要验证的变量只有"模型会不会调工具"，接真实的
 * minimal-archive 会把 S3 可用性、事实结构这些无关变量混进来，跑挂了分不清是谁的错。
 */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_project_documents',
      description:
        '列出当前项目里所有文件的清单，包含文件名、当前归档阶段、阶段是人工确认的还是按文件名规则落的、以及内容有没有被读取过。不需要任何参数。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

/** 假的文件清单。刻意造出"两份同名章程都没读过内容"的局面，让工具值得被调用。 */
const FAKE_DOCUMENTS = [
  {
    文件名: '君柔公司章程.pdf',
    当前阶段: 'investment_execution',
    阶段来源: '按命名规范落位，未经人工确认',
    内容读过吗: '否，只有文件名',
  },
  {
    文件名: '君柔公司章程(2).pdf',
    当前阶段: 'investment_execution',
    阶段来源: '按命名规范落位，未经人工确认',
    内容读过吗: '否，只有文件名',
  },
  {
    文件名: '君柔股东会决议.pdf',
    当前阶段: 'investment_execution',
    阶段来源: '人工确认',
    内容读过吗: '否，只有文件名',
  },
  {
    文件名: '君柔尽职调查报告.pdf',
    当前阶段: 'due_diligence',
    阶段来源: '人工确认',
    内容读过吗: '是',
  },
  {
    文件名: '君柔立项申请表.pdf',
    当前阶段: 'initiation',
    阶段来源: '人工确认',
    内容读过吗: '是',
  },
];

function runTool(name) {
  if (name === 'list_project_documents') {
    return JSON.stringify({ documents: FAKE_DOCUMENTS }, null, 2);
  }
  return JSON.stringify({ error: `未知工具：${name}` });
}

const SYSTEM_PROMPT = `你在协助整理一个投资项目的档案。

你手上有工具可以用。需要事实才能回答的问题，先调工具拿事实，不要凭空猜测文件情况。

判断时不许凭文件类型猜阶段——"章程通常属于投资实施"这种结论不作数，要指着具体证据说话。`;

const USER_PROMPT = `这个项目里有没有哪些文件，光看文件名分不出先后、必须读内容才能定？

先弄清楚项目里到底有什么文件，再回答。`;

const MAX_ROUNDS = 6;

let toolCallCount = 0;
let round = 0;
const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: USER_PROMPT },
];

console.log(`模型：${model}`);
console.log(`网关：${baseUrl.replace(/\/$/, '')}`);
console.log(`工具：${TOOLS.map(t => t.function.name).join(', ')}`);
console.log('─'.repeat(72));

try {
  // 这就是 agent 的全部内核：反复问，它要工具就给，不要了就结束。
  while (round < MAX_ROUNDS) {
    round += 1;
    const startedAt = Date.now();

    /**
     * 必须走流式。网关一律以 SSE 返回，即使没要求流式——这个坑 probe-model.mjs
     * 里已经踩过并记下了。SDK 的 .stream() 正好吃 SSE，并在 finalChatCompletion()
     * 里把分片归并成完整消息。
     */
    const stream = client.chat.completions.stream({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 800,
      // 网关的非标字段，与现有代码保持一致。SDK 会原样透传未知字段。
      thinking: { type: 'disabled' },
    });

    const completion = await stream.finalChatCompletion();
    const choice = completion.choices?.[0];
    const message = choice?.message;
    const elapsed = Date.now() - startedAt;

    if (!message) {
      console.log(`第 ${round} 轮：网关没返回 message，原始响应：`);
      console.log(JSON.stringify(completion, null, 2).slice(0, 1200));
      break;
    }

    console.log(
      `\n第 ${round} 轮（${elapsed}ms，finish_reason=${choice.finish_reason ?? '未知'}）`
    );
    if (message.content) {
      console.log(`  模型说：${message.content.trim()}`);
    }

    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      console.log('  没有请求工具 —— 这是最终答复，循环结束。');
      break;
    }

    for (const call of calls) {
      toolCallCount += 1;
      const name = call.function?.name ?? '(无名)';
      const rawArgs = call.function?.arguments ?? '';
      console.log(`  → 请求调用工具：${name}`);
      console.log(`     参数原文：${rawArgs || '(空)'}`);

      // 参数一律用 JSON.parse 解析，绝不对原始字符串做匹配——各家模型的转义习惯不同。
      if (rawArgs.trim()) {
        try {
          JSON.parse(rawArgs);
        } catch (error) {
          console.log(`     ⚠️ 参数不是合法 JSON：${error.message}`);
        }
      }

      const result = runTool(name);
      console.log(`     ← 返回 ${FAKE_DOCUMENTS.length} 份文件的清单`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  console.log('\n' + '─'.repeat(72));
  if (toolCallCount > 0) {
    console.log(`✅ 通过：模型主动请求了 ${toolCallCount} 次工具调用，共 ${round} 轮。`);
    console.log('   这条网关上的 function calling 可用，深挖 Agent 方案的地基成立。');
  } else {
    console.log('❌ 未通过：模型一次都没请求工具，直接给了答复。');
    console.log('   可能原因：该模型不支持 function calling；网关吞掉了 tools 字段；');
    console.log('   或者提示词不够让它觉得需要工具。换个模型 ID 再跑一次再下结论。');
    process.exitCode = 1;
  }
} catch (error) {
  console.log('\n' + '─'.repeat(72));
  console.log('❌ 请求失败，没跑到判断这一步。');
  console.log(`   ${error?.message ?? error}`);
  if (error?.status) console.log(`   HTTP 状态：${error.status}`);
  if (error?.error) {
    console.log(`   网关返回：${JSON.stringify(error.error).slice(0, 500)}`);
  }
  console.log(
    '\n   如果错误提到 tools 字段不被接受，那就是网关这一层不透传工具定义，\n' +
      '   与模型能力无关——这种情况方案要改走别的路子。'
  );
  process.exitCode = 1;
}
