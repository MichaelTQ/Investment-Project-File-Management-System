#!/usr/bin/env node
/**
 * 探测模型会不会「顺藤摸瓜」——深挖 Agent 方案真正押的宝。
 *
 * probe-tool-calling.mjs 验证的是"模型会开口要工具"。这个验证的是更关键的一件事：
 * **读完第一份文件、发现证据不够之后，它会不会自己决定去读第二份特定的文件。**
 *
 * 为什么这是赌注：如果模型不会顺藤摸瓜，那深挖旁路就没有存在价值——还不如一次性
 * 把所有文件的事实都喂给它，压根不需要 agent 循环。整个方案成立与否系于此。
 *
 * 场景取自君柔实测里最难的那一处：两份同名公司章程，各自都说得通，唯一能定方向的
 * 证据（股东会决议记载"由 A 变更为 B"）在第三份文件里。
 *
 * 用法：
 *   node scripts/probe-tool-chain.mjs                  # 用默认模型
 *   node scripts/probe-tool-chain.mjs 模型ID            # 指定模型
 *
 * 需要环境变量 COZE_INTEGRATION_MODEL_BASE_URL 和 COZE_WORKLOAD_IDENTITY_API_KEY。
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

const model = process.argv[2]?.trim() || 'doubao-seed-2-0-mini-260215';

const client = new OpenAI({
  baseURL: baseUrl.replace(/\/$/, ''),
  apiKey,
  timeout: 120_000,
  defaultHeaders: {
    'X-Client-Sdk': 'coze-coding-dev-sdk-typescript/0.3.0',
  },
});

// ── 预算：与 DEEPEN_AGENT_PLAN.md 第 5 节一致 ──────────────────────────────
const MAX_EXTRACTS = 3; // 读文件是唯一花钱的动作
const MAX_ROUNDS = 8;

// ── 假档案 ────────────────────────────────────────────────────────────────
// 事实是写死的。本次要验证的变量只有"模型会不会连着读第二份"，接真实 OCR 会把
// 扫描件质量、抽取准确率这些无关因素混进来。
//
// 关键设计：单看《君柔公司章程.pdf》，11.73624 这个数字什么也说明不了。只有拿到
// 股东会决议里的"由 11.73624 变更为 13.04027"，才能把它钉在变更之前。

const DOCUMENTS = [
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

const FACTS = {
  '君柔公司章程.pdf': {
    文档类型: '公司章程',
    日期: [{ 含义: '章程落款日期', 值: '2023-05-10' }],
    数值记载: [{ 字段: '注册资本', 值: '11.73624万元' }],
    字段变更: [], // 本文件自身不记载任何变更——这是它单独定不了方向的原因
    原文摘录: ['公司注册资本为人民币 11.73624 万元。'],
    事实来源: '视觉摘要（扫描件）',
  },
  '君柔公司章程(2).pdf': {
    文档类型: '公司章程',
    日期: [{ 含义: '章程落款日期', 值: '2024-03-15' }],
    数值记载: [{ 字段: '注册资本', 值: '13.04027万元' }],
    字段变更: [],
    原文摘录: ['公司注册资本为人民币 13.04027 万元。'],
    事实来源: '视觉摘要（扫描件）',
  },
  '君柔股东会决议.pdf': {
    文档类型: '股东会决议',
    日期: [{ 含义: '决议通过日期', 值: '2024-02-20' }],
    数值记载: [],
    字段变更: [
      { 字段: '注册资本', 变更前: '11.73624万元', 变更后: '13.04027万元' },
    ],
    原文摘录: [
      '同意公司注册资本由人民币 11.73624 万元变更为人民币 13.04027 万元。',
    ],
    事实来源: '视觉摘要（扫描件）',
  },
  '君柔尽职调查报告.pdf': {
    文档类型: '尽职调查报告',
    日期: [{ 含义: '报告出具日期', 值: '2023-08-01' }],
    数值记载: [],
    字段变更: [],
    原文摘录: ['本次尽职调查覆盖财务、法律、业务三方面。'],
    事实来源: '文字层',
  },
  '君柔立项申请表.pdf': {
    文档类型: '立项申请表',
    日期: [{ 含义: '申请日期', 值: '2023-03-02' }],
    数值记载: [],
    字段变更: [],
    原文摘录: ['拟对君柔项目进行股权投资，申请立项。'],
    事实来源: '文字层',
  },
};

// ── 工具定义 ──────────────────────────────────────────────────────────────
// 描述里只讲工具干什么、什么时候用，不夹带任何关于本题答案的暗示。

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_project_documents',
      description:
        '列出当前项目里所有文件的清单：文件名、当前归档阶段、阶段是人工确认的还是按文件名规则落的、内容有没有被读取过。不需要参数。想知道项目里有什么文件时先调它。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_document_facts',
      description:
        '读取一份文件的内容并抽取其中的客观事实：文档类型、日期、数值记载、字段变更（形如"某字段由 A 变更为 B"）、原文摘录。这个操作要调用视觉模型读扫描件，慢且花钱，按需调用。',
      parameters: {
        type: 'object',
        properties: {
          文件名: {
            type: 'string',
            description: '要读取的文件名，必须与文件清单里的名称完全一致。',
          },
        },
        required: ['文件名'],
      },
    },
  },
];

// ── 记账 ──────────────────────────────────────────────────────────────────
let extractCount = 0;
const extractOrder = []; // 按顺序记下它选了哪些文件——这是本次最重要的观测数据

function runTool(name, rawArgs) {
  if (name === 'list_project_documents') {
    return JSON.stringify({ documents: DOCUMENTS }, null, 2);
  }

  if (name === 'extract_document_facts') {
    let args = {};
    try {
      args = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return JSON.stringify({ error: '参数不是合法 JSON。' });
    }
    const fileName = args['文件名'] ?? args.fileName ?? args.filename;
    if (!fileName || !FACTS[fileName]) {
      return JSON.stringify({
        error: `文件不存在：${fileName ?? '(未提供文件名)'}。请先调 list_project_documents 看清单。`,
      });
    }
    if (extractCount >= MAX_EXTRACTS) {
      return JSON.stringify({
        error: `读取预算已用尽（上限 ${MAX_EXTRACTS} 份）。请基于已有事实给出结论，并说清还缺什么。`,
      });
    }
    extractCount += 1;
    extractOrder.push(fileName);
    return JSON.stringify({ 文件名: fileName, 事实: FACTS[fileName] }, null, 2);
  }

  return JSON.stringify({ error: `未知工具：${name}` });
}

// ── 提示词 ────────────────────────────────────────────────────────────────
// 两条硬约束来自 DEEPEN_AGENT_PLAN.md 第 5 节，是踩过坑写下来的。

const SYSTEM_PROMPT = `你在协助整理一个投资项目的档案，任务是判断文件之间的先后关系。

工作方式：需要事实就调工具去取，不要凭空猜测文件内容。读文件慢且花钱，最多读 ${MAX_EXTRACTS} 份，挑真正能定结论的读。

两条硬规矩：

1. 不许凭文件类型猜先后。"章程通常是投资后形成的"这类结论不作数——要指着文件里的具体数字或措辞说话。
2. 打印时间、OA 截图时间不是文件的形成时间，不能拿来当日期证据。

如果读完仍然定不了，就明说定不了，并说清**还缺一份记载什么的文件**——只说"证据不足"没有用。`;

const USER_PROMPT = `《君柔公司章程.pdf》这份文件，形成于本次增资之前还是之后？

给出你的依据。`;

// ── 循环 ──────────────────────────────────────────────────────────────────
const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: USER_PROMPT },
];

let round = 0;
let finalAnswer = '';
let totalMs = 0;

console.log(`模型：${model}`);
console.log(`网关：${baseUrl.replace(/\/$/, '')}`);
console.log(`工具：${TOOLS.map(t => t.function.name).join(', ')}`);
console.log(`预算：最多读 ${MAX_EXTRACTS} 份文件、最多 ${MAX_ROUNDS} 轮`);
console.log(`问题：${USER_PROMPT.split('\n')[0]}`);
console.log('─'.repeat(72));

try {
  while (round < MAX_ROUNDS) {
    round += 1;
    const startedAt = Date.now();

    const stream = client.chat.completions.stream({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 1000,
      thinking: { type: 'disabled' },
    });

    const completion = await stream.finalChatCompletion();
    const choice = completion.choices?.[0];
    const message = choice?.message;
    const elapsed = Date.now() - startedAt;
    totalMs += elapsed;

    if (!message) {
      console.log(`\n第 ${round} 轮：网关没返回 message，原始响应：`);
      console.log(JSON.stringify(completion, null, 2).slice(0, 1200));
      break;
    }

    console.log(
      `\n第 ${round} 轮（${elapsed}ms，finish_reason=${choice.finish_reason ?? '未知'}）`
    );
    if (message.content?.trim()) {
      console.log(`  模型说：${message.content.trim()}`);
    }

    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      finalAnswer = message.content?.trim() ?? '';
      console.log('  没有请求工具 —— 这是最终答复，循环结束。');
      break;
    }

    for (const call of calls) {
      const name = call.function?.name ?? '(无名)';
      const rawArgs = call.function?.arguments ?? '';
      console.log(`  → 调用 ${name}  参数：${rawArgs || '{}'}`);
      const result = runTool(name, rawArgs);
      const preview = result.length > 160 ? result.slice(0, 160) + ' …' : result;
      console.log(`     ← ${preview.replace(/\s+/g, ' ')}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  if (round >= MAX_ROUNDS && !finalAnswer) {
    console.log(`\n⚠️ 轮数用尽（${MAX_ROUNDS} 轮）仍未给出最终答复。`);
  }

  // ── 判定 ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(`读取顺序：${extractOrder.length ? extractOrder.join(' → ') : '（一份都没读）'}`);
  console.log(`共 ${round} 轮，读了 ${extractCount} 份，总耗时 ${(totalMs / 1000).toFixed(1)} 秒`);
  console.log('─'.repeat(72));

  const readCharter = extractOrder.includes('君柔公司章程.pdf');
  const readResolution = extractOrder.includes('君柔股东会决议.pdf');
  // 关键动作：先读了目标章程，之后才去读决议——说明是"发现不够"才回头找的
  const chained =
    readCharter &&
    readResolution &&
    extractOrder.indexOf('君柔股东会决议.pdf') > extractOrder.indexOf('君柔公司章程.pdf');

  const answer = finalAnswer.replace(/\s/g, '');
  const saysBefore = /增资之前|变更之前|之前形成|增资前/.test(answer);
  const saysAfter = /增资之后|变更之后|之后形成|增资后/.test(answer);
  // 结论正确 = 说了"之前"，且没有同时主张"之后"
  const correct = saysBefore && !saysAfter;
  const citesNumber = /11\.73624/.test(answer);

  console.log(`  取证链  ${chained ? '✅ 成立' : '❌ 未成立'}：${
    chained
      ? '先读目标章程、发现定不了方向，再回头去读股东会决议'
      : readResolution
        ? '读了决议，但不是在读完章程之后才去读的（更像一次性把能读的都读了）'
        : '始终没有去读股东会决议'
  }`);
  console.log(`  结论    ${correct ? '✅ 正确' : '❌ 不正确或含糊'}：${
    correct ? '判定为形成于增资之前' : saysAfter ? '判成了增资之后（方向反了）' : '没有给出明确方向'
  }`);
  console.log(`  引用证据 ${citesNumber ? '✅ 引用了 11.73624 这个具体数字' : '⚠️ 未引用具体数字'}`);
  console.log(`  预算    读了 ${extractCount}/${MAX_EXTRACTS} 份${
    extractCount >= MAX_EXTRACTS ? '（用满了，可能存在盲目通读倾向）' : ''
  }`);

  console.log('─'.repeat(72));
  if (chained && correct) {
    console.log('✅ 通过：模型会顺藤摸瓜，深挖 Agent 的核心假设成立。');
    process.exitCode = 0;
  } else if (correct) {
    console.log('🟡 部分通过：结论对，但没有走出"发现不够→回头取证"的链路。');
    console.log('   它更像是把能读的都读了再一起判断。这仍然有价值（比只看文件名强），');
    console.log('   但 agent 相对于"一次性喂全部事实"的增量变小了——值不值得做要重新算账。');
    process.exitCode = 0;
  } else {
    console.log('❌ 未通过：核心假设不成立，方案需要改。');
    console.log('   先换成 doubao-seed-2-0-pro-260215 再跑一次再下结论——');
    console.log('   如果 pro 能走通而 mini 不行，那就是模型选型问题，不是方案问题。');
    process.exitCode = 1;
  }
} catch (error) {
  console.log('\n' + '═'.repeat(72));
  console.log('❌ 请求失败，没跑到判断这一步。');
  console.log(`   ${error?.message ?? error}`);
  if (error?.status) console.log(`   HTTP 状态：${error.status}`);
  if (error?.error) {
    console.log(`   网关返回：${JSON.stringify(error.error).slice(0, 500)}`);
  }
  process.exitCode = 1;
}
