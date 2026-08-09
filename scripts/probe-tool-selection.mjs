#!/usr/bin/env node
/**
 * 探测：读不起全部文件的时候，模型会不会把钱花在对的那几份上。
 *
 * 这是深挖 Agent 值不值得做的决定性问题。
 *
 * 替代方案（"一次性把所有文件的事实喂给模型"）有个前提：你得先花钱把每一份都抽过
 * 事实。而抽事实要调视觉模型读扫描件，慢且贵。**决定为哪几份付钱，本身就是那个
 * 值得交给 agent 的决策。** 如果模型不会挑、只会把能读的都读一遍，那它相对于现在
 * "人工挑几份深挖"就没有增量。
 *
 * 与上一版（已删除的 probe-tool-chain.mjs）的区别：那版 5 份文件、未读 3 份、
 * 预算 3 份——把没读的全读了就通关，分不出"会挑"和"全读"。这版 10 份文件、未读 8 份、
 * **预算只有 2 份**，读不起全部，必须挑。
 *
 * 用法：
 *   node scripts/probe-tool-selection.mjs                  # 默认模型
 *   node scripts/probe-tool-selection.mjs 模型ID            # 指定模型
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
  defaultHeaders: { 'X-Client-Sdk': 'coze-coding-dev-sdk-typescript/0.3.0' },
});

// ── 预算：故意卡死 ────────────────────────────────────────────────────────
const MAX_EXTRACTS = 2; // 8 份未读，只给 2 次机会——读不起全部，必须挑
const MAX_ROUNDS = 8;

const TARGET = '君柔公司章程.pdf';
const KEY_EVIDENCE = '君柔股东会决议.pdf';
const TRAP = '君柔公司章程(2).pdf';

// ── 假档案：10 份，8 份未读 ──────────────────────────────────────────────
// 真正管用的只有 2 份（目标章程 + 股东会决议）。其余全是名字很像的干扰项。

const DOCUMENTS = [
  { 文件名: TARGET, 当前阶段: 'investment_execution', 阶段来源: '按命名规范落位，未经人工确认', 内容读过吗: '否' },
  { 文件名: TRAP, 当前阶段: 'investment_execution', 阶段来源: '按命名规范落位，未经人工确认', 内容读过吗: '否' },
  { 文件名: KEY_EVIDENCE, 当前阶段: 'investment_execution', 阶段来源: '人工确认', 内容读过吗: '否' },
  { 文件名: '君柔投委会决议.pdf', 当前阶段: 'investment_decision', 阶段来源: '人工确认', 内容读过吗: '否' },
  { 文件名: '君柔工商变更登记表.pdf', 当前阶段: 'investment_execution', 阶段来源: '人工确认', 内容读过吗: '否' },
  { 文件名: '君柔转账凭证.pdf', 当前阶段: 'investment_execution', 阶段来源: '按命名规范落位，未经人工确认', 内容读过吗: '否' },
  { 文件名: '君柔审计报告.pdf', 当前阶段: 'due_diligence', 阶段来源: '按命名规范落位，未经人工确认', 内容读过吗: '否' },
  { 文件名: '君柔资产评估报告.pdf', 当前阶段: 'due_diligence', 阶段来源: '人工确认', 内容读过吗: '否' },
  { 文件名: '君柔尽职调查报告.pdf', 当前阶段: 'due_diligence', 阶段来源: '人工确认', 内容读过吗: '是' },
  { 文件名: '君柔立项申请表.pdf', 当前阶段: 'initiation', 阶段来源: '人工确认', 内容读过吗: '是' },
];

const FACTS = {
  // ✅ 目标：必须读，但单看它定不了方向——11.73624 孤立地看什么也说明不了
  [TARGET]: {
    文档类型: '公司章程', 日期: [{ 含义: '章程落款日期', 值: '2023-05-10' }],
    数值记载: [{ 字段: '注册资本', 值: '11.73624万元' }], 字段变更: [],
    原文摘录: ['公司注册资本为人民币 11.73624 万元。'], 事实来源: '视觉摘要（扫描件）',
  },
  // ⚠️ 陷阱：直觉上最该拿来对比的，但它也不记载变更，读了照样定不了方向
  [TRAP]: {
    文档类型: '公司章程', 日期: [{ 含义: '章程落款日期', 值: '2024-03-15' }],
    数值记载: [{ 字段: '注册资本', 值: '13.04027万元' }], 字段变更: [],
    原文摘录: ['公司注册资本为人民币 13.04027 万元。'], 事实来源: '视觉摘要（扫描件）',
  },
  // ✅ 唯一能定方向的证据
  [KEY_EVIDENCE]: {
    文档类型: '股东会决议', 日期: [{ 含义: '决议通过日期', 值: '2024-02-20' }],
    数值记载: [],
    字段变更: [{ 字段: '注册资本', 变更前: '11.73624万元', 变更后: '13.04027万元' }],
    原文摘录: ['同意公司注册资本由人民币 11.73624 万元变更为人民币 13.04027 万元。'],
    事实来源: '视觉摘要（扫描件）',
  },
  // 干扰：也叫"决议"，但记的是投资决策，与资本变更无关
  '君柔投委会决议.pdf': {
    文档类型: '投资决策委员会决议', 日期: [{ 含义: '会议日期', 值: '2023-11-08' }],
    数值记载: [{ 字段: '拟投资金额', 值: '2000万元' }], 字段变更: [],
    原文摘录: ['同意对君柔项目进行投资，投资金额人民币 2000 万元。'], 事实来源: '视觉摘要（扫描件）',
  },
  // 强干扰：名字里就有"变更"，但变的是法定代表人，不是注册资本
  '君柔工商变更登记表.pdf': {
    文档类型: '工商变更登记表', 日期: [{ 含义: '登记日期', 值: '2024-03-20' }],
    数值记载: [],
    字段变更: [{ 字段: '法定代表人', 变更前: '张某', 变更后: '李某' }],
    原文摘录: ['变更事项：法定代表人由张某变更为李某。'], 事实来源: '视觉摘要（扫描件）',
  },
  '君柔转账凭证.pdf': {
    文档类型: '转账凭证', 日期: [{ 含义: '付款日期', 值: '2024-03-01' }],
    数值记载: [{ 字段: '付款金额', 值: '2000万元' }], 字段变更: [],
    原文摘录: ['付款金额人民币 2000 万元整。'], 事实来源: '视觉摘要（扫描件）',
  },
  '君柔审计报告.pdf': {
    文档类型: '审计报告', 日期: [{ 含义: '报告日期', 值: '2024-01-15' }],
    数值记载: [{ 字段: '净资产', 值: '8650万元' }], 字段变更: [],
    原文摘录: ['截至 2023 年 12 月 31 日，公司净资产为人民币 8650 万元。'], 事实来源: '文字层',
  },
  '君柔资产评估报告.pdf': {
    文档类型: '资产评估报告', 日期: [{ 含义: '评估基准日', 值: '2023-09-30' }],
    数值记载: [{ 字段: '评估值', 值: '12300万元' }], 字段变更: [],
    原文摘录: ['本次评估结论为人民币 12300 万元。'], 事实来源: '文字层',
  },
  '君柔尽职调查报告.pdf': {
    文档类型: '尽职调查报告', 日期: [{ 含义: '报告出具日期', 值: '2023-08-01' }],
    数值记载: [], 字段变更: [], 原文摘录: ['本次尽职调查覆盖财务、法律、业务三方面。'], 事实来源: '文字层',
  },
  '君柔立项申请表.pdf': {
    文档类型: '立项申请表', 日期: [{ 含义: '申请日期', 值: '2023-03-02' }],
    数值记载: [], 字段变更: [], 原文摘录: ['拟对君柔项目进行股权投资，申请立项。'], 事实来源: '文字层',
  },
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_project_documents',
      description:
        '列出当前项目里所有文件的清单：文件名、当前归档阶段、阶段是人工确认的还是按文件名规则落的、内容有没有被读取过。不需要参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_document_facts',
      description:
        '读取一份文件的内容并抽取客观事实：文档类型、日期、数值记载、字段变更（形如"某字段由 A 变更为 B"）、原文摘录。这个操作要调用视觉模型读扫描件，慢且花钱。',
      parameters: {
        type: 'object',
        properties: {
          文件名: { type: 'string', description: '要读取的文件名，必须与清单里完全一致。' },
        },
        required: ['文件名'],
      },
    },
  },
];

let extractCount = 0;
const extractLog = []; // { file, round }——必须记轮次，同轮并发不算链式取证

function runTool(name, rawArgs, round) {
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
      return JSON.stringify({ error: `文件不存在：${fileName ?? '(未提供)'}。` });
    }
    if (extractCount >= MAX_EXTRACTS) {
      return JSON.stringify({
        error: `读取预算已用尽（上限 ${MAX_EXTRACTS} 份），无法再读。请基于已有事实作答；若定不了，请说清还缺一份记载什么的文件。`,
      });
    }
    extractCount += 1;
    extractLog.push({ file: fileName, round });
    return JSON.stringify({ 文件名: fileName, 事实: FACTS[fileName] }, null, 2);
  }
  return JSON.stringify({ error: `未知工具：${name}` });
}

const SYSTEM_PROMPT = `你在协助整理一个投资项目的档案，任务是判断文件之间的先后关系。

需要事实就调工具去取，不要凭空猜测文件内容。

**读文件要调视觉模型读扫描件，慢且花钱，你最多只能读 ${MAX_EXTRACTS} 份。** 项目里未读的文件远不止 ${MAX_EXTRACTS} 份，所以你必须挑——挑那些真正能定结论的读，不要把机会花在看起来相关但定不了事的文件上。

两条硬规矩：

1. 不许凭文件类型猜先后。"章程通常是投资后形成的"这类结论不作数——要指着文件里的具体数字或措辞说话。
2. 打印时间、OA 截图时间不是文件的形成时间，不能当日期证据。

如果读完仍然定不了，就明说定不了，并说清**还缺一份记载什么的文件**。只说"证据不足"没有用。硬编一个说得通但没有证据支撑的结论，比说定不了糟糕得多。`;

const USER_PROMPT = `《${TARGET}》这份文件，形成于本次增资之前还是之后？

给出你的依据。`;

const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: USER_PROMPT },
];

let round = 0;
let finalAnswer = '';
let totalMs = 0;

console.log(`模型：${model}`);
console.log(`档案：${DOCUMENTS.length} 份文件，其中未读 ${DOCUMENTS.filter(d => d.内容读过吗 === '否').length} 份`);
console.log(`预算：最多读 ${MAX_EXTRACTS} 份（故意不够，必须挑）`);
console.log(`正解：${TARGET} + ${KEY_EVIDENCE}`);
console.log(`陷阱：${TRAP}（直觉上想拿来对比，但它不记载变更，读了照样定不了）`);
console.log('─'.repeat(72));

try {
  while (round < MAX_ROUNDS) {
    round += 1;
    const startedAt = Date.now();

    const stream = client.chat.completions.stream({
      model, messages, tools: TOOLS, tool_choice: 'auto',
      max_tokens: 1000, thinking: { type: 'disabled' },
    });

    const completion = await stream.finalChatCompletion();
    const choice = completion.choices?.[0];
    const message = choice?.message;
    totalMs += Date.now() - startedAt;

    if (!message) {
      console.log(`\n第 ${round} 轮：网关没返回 message。`);
      console.log(JSON.stringify(completion, null, 2).slice(0, 1000));
      break;
    }

    console.log(`\n第 ${round} 轮（${Date.now() - startedAt}ms，${choice.finish_reason ?? '未知'}）`);
    if (message.content?.trim()) console.log(`  模型说：${message.content.trim()}`);

    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      finalAnswer = message.content?.trim() ?? '';
      console.log('  最终答复，循环结束。');
      break;
    }

    for (const call of calls) {
      const name = call.function?.name ?? '(无名)';
      const rawArgs = call.function?.arguments ?? '';
      console.log(`  → ${name}  ${rawArgs || '{}'}`);
      const result = runTool(name, rawArgs, round);
      const brief = result.length > 140 ? result.slice(0, 140) + ' …' : result;
      console.log(`     ← ${brief.replace(/\s+/g, ' ')}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  // ── 判定 ────────────────────────────────────────────────────────────────
  const read = extractLog.map(e => e.file);
  const readSet = new Set(read);
  const rounds = new Set(extractLog.map(e => e.round));

  console.log('\n' + '═'.repeat(72));
  console.log(`读了：${read.length ? extractLog.map(e => `${e.file}（第${e.round}轮）`).join('  ') : '（一份都没读）'}`);
  console.log(`共 ${round} 轮，读 ${extractCount}/${MAX_EXTRACTS} 份，耗时 ${(totalMs / 1000).toFixed(1)} 秒`);
  console.log('─'.repeat(72));

  const gotTarget = readSet.has(TARGET);
  const gotKey = readSet.has(KEY_EVIDENCE);
  const gotTrap = readSet.has(TRAP);
  const perfectPick = gotTarget && gotKey && readSet.size === 2;

  const answer = finalAnswer.replace(/\s/g, '');
  const saysBefore = /增资之前|变更之前|之前形成|增资前|早于/.test(answer);
  const saysAfter = /增资之后|变更之后|之后形成|增资后|晚于/.test(answer);
  const concluded = saysBefore !== saysAfter; // 给了明确方向（不是两头都说）
  const correct = saysBefore && !saysAfter;
  const admitsUnknown = /定不了|无法判断|无法确定|不能确定|证据不足|还缺|尚缺/.test(answer);
  const namesWhatsMissing = /变更|决议|由.{0,12}变更为/.test(answer) && admitsUnknown;

  console.log(`  选文件  ${perfectPick ? '✅ 完美' : gotKey ? '🟡 够用' : '❌ 没选中关键证据'}：${
    perfectPick
      ? `两次机会正好花在 ${TARGET} 和 ${KEY_EVIDENCE} 上`
      : gotKey
        ? '读到了股东会决议，但也花了机会在别处'
        : gotTrap
          ? `中了陷阱——把机会花在 ${TRAP} 上，那份不记载变更，解不了题`
          : '没读到唯一能定方向的那份文件'
  }`);
  console.log(`  取证方式 ${rounds.size > 1 ? '跨轮（读完一份再决定下一份）' : '同一轮内一次性发出'}`);

  if (gotKey) {
    console.log(`  结论    ${correct ? '✅ 正确' : saysAfter ? '❌ 方向反了' : '⚠️ 没给明确方向'}`);
  } else {
    console.log(`  诚实度  ${
      admitsUnknown && namesWhatsMissing
        ? '✅ 承认定不了，并说清了缺一份记载资本变更的文件'
        : admitsUnknown
          ? '🟡 承认定不了，但没说清缺什么'
          : concluded
            ? '❌ 没有证据却硬给了结论——这是最危险的失败方式'
            : '⚠️ 答复含糊'
    }`);
  }

  console.log('─'.repeat(72));
  if (perfectPick && correct) {
    console.log('✅ 通过：读不起全部时它会挑对文件。深挖 Agent 的核心价值成立。');
  } else if (gotKey && correct) {
    console.log('🟡 基本通过：挑中了关键证据、结论正确，但有一次机会花偏了。');
    console.log('   真实场景里预算可以给宽一点，这个偏差可以接受。');
  } else if (!gotKey && admitsUnknown && namesWhatsMissing) {
    console.log('🟡 没挑对，但行为是安全的：它承认定不了，还说清了缺什么。');
    console.log('   按方案原则三，"判不出来"的代价只是把活推还给人，可以接受。');
    console.log('   但 agent 的增量因此变小——建议换 pro 再跑，或放宽预算再看。');
  } else {
    console.log('❌ 未通过。');
    if (!gotKey && concluded && !admitsUnknown) {
      console.log('   最坏的一种：没拿到证据却给了自信的结论。这正是方案里说的');
      console.log('   "系统给出一个自信的错误答案，而人没有理由去怀疑它"。');
    }
    console.log('   先换 doubao-seed-2-0-pro-260215 再跑一次再下结论。');
    process.exitCode = 1;
  }
} catch (error) {
  console.log('\n' + '═'.repeat(72));
  console.log('❌ 请求失败：' + (error?.message ?? error));
  if (error?.status) console.log(`   HTTP ${error.status}`);
  process.exitCode = 1;
}
