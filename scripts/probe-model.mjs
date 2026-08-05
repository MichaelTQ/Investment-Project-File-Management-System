#!/usr/bin/env node
/**
 * 探测当前环境的模型网关支持哪些模型。
 *
 * 换模型之前先跑这个，别凭 ID 猜。网关认不认某个模型，只有它自己知道。
 *
 * 用法：
 *   node scripts/probe-model.mjs                    # 探测内置候选清单
 *   node scripts/probe-model.mjs 模型ID1 模型ID2      # 探测指定的
 *
 * 需要环境变量 COZE_INTEGRATION_MODEL_BASE_URL 和 COZE_WORKLOAD_IDENTITY_API_KEY，
 * 也就是应用跑起来时用的那两个。
 */

const baseUrl = process.env.COZE_INTEGRATION_MODEL_BASE_URL;
const apiKey = process.env.COZE_WORKLOAD_IDENTITY_API_KEY;

if (!baseUrl || !apiKey) {
  console.error(
    '缺少 COZE_INTEGRATION_MODEL_BASE_URL 或 COZE_WORKLOAD_IDENTITY_API_KEY。\n' +
      '请在应用能正常调用模型的那个环境里运行本脚本。'
  );
  process.exit(1);
}

const candidates =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        // 抽事实在用的（照抄原文，不需要推理）
        'doubao-seed-2-0-mini-260215',
        // 判阶段与冲突复核在用的（需要推理，实测比 mini 慢约 3 秒）
        'doubao-seed-2-0-pro-260215',
        // 实测本环境不存在，留着是为了记住"同代非 mini 版并不存在"这件事
        'doubao-seed-2-0-260215',
        // SDK 自带默认
        'doubao-seed-1-8-251228',
      ];

/**
 * 网关一律以 SSE 返回（data: {...} 分行，object 为 chat.completion.chunk），
 * 即使没要求流式。按整块 JSON 解析会把可用的模型误判成不可用——这个坑踩过一次。
 * 解析方式与 src/lib/classification/chat-completions.ts 保持一致。
 */
function parseGatewayResponse(rawText) {
  if (!rawText.trimStart().startsWith('data:')) {
    try {
      return JSON.parse(rawText);
    } catch {
      return null;
    }
  }

  let merged = null;
  let content = '';
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const body = trimmed.slice(5).trim();
    if (!body || body === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(body);
    } catch {
      continue;
    }
    // 报错也走 SSE 通道，第一块就是它。
    if (chunk?.error) return chunk;
    merged ??= chunk;
    content +=
      chunk?.choices?.[0]?.delta?.content ??
      chunk?.choices?.[0]?.message?.content ??
      '';
  }
  if (!merged) return null;
  return { ...merged, choices: [{ message: { content } }] };
}

async function probe(model) {
  const startedAt = Date.now();
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Client-Sdk': 'coze-coding-dev-sdk-typescript/0.3.0',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '回复两个字：可用' }],
          temperature: 0,
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(60_000),
      }
    );

    const durationMs = Date.now() - startedAt;
    const text = await response.text();
    const payload = parseGatewayResponse(text);
    if (!payload) {
      return { model, ok: false, durationMs, detail: text.slice(0, 200) };
    }

    const content =
      payload?.choices?.[0]?.message?.content ??
      payload?.choices?.[0]?.delta?.content ??
      payload?.data?.choices?.[0]?.message?.content;
    if (response.ok && content) {
      return { model, ok: true, durationMs, detail: String(content).trim() };
    }
    return {
      model,
      ok: false,
      durationMs,
      detail:
        payload?.error?.message ??
        payload?.message ??
        `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      model,
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = [];
for (const model of candidates) {
  const result = await probe(model);
  results.push(result);
  console.log(
    `${result.ok ? '✅ 可用' : '❌ 不可用'}  ${result.model}  ` +
      `(${result.durationMs}ms)  ${result.detail}`
  );
}

const usable = results.filter(item => item.ok).map(item => item.model);
console.log(
  usable.length > 0
    ? `\n可用模型：${usable.join('、')}\n把选中的那个填进 CONFLICT_REVIEW_MODEL 环境变量即可，无需改代码。`
    : '\n没有一个候选可用。请确认环境变量指向的网关，或向平台确认可用模型清单。'
);
