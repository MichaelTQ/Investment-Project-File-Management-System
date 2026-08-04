import assert from 'node:assert/strict';
import test from 'node:test';

import {
  invokeChatCompletion,
  parseChatCompletionResponse,
} from '../src/lib/classification/chat-completions';

test('聚合 Coze SSE Chat Completions 内容和结束原因', () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"{\\"title\\":"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"content":"\\"立项申请\\"}"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
  ].join('\n');

  const parsed = parseChatCompletionResponse(raw, 'text/event-stream');
  assert.equal(parsed.content, '{"title":"立项申请"}');
  assert.equal(parsed.finishReason, 'stop');
});

test('仍兼容标准非流式 Chat Completions 响应', () => {
  const parsed = parseChatCompletionResponse(
    JSON.stringify({
      choices: [
        { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }),
    'application/json'
  );
  assert.equal(parsed.content, '{"ok":true}');
  assert.equal(parsed.promptTokens, 12);
  assert.equal(parsed.outputTokens, 5);
});

test('异常成功响应会显示上游字段、错误码和提示', () => {
  assert.throws(
    () =>
      parseChatCompletionResponse(
        JSON.stringify({ code: 4001, message: 'unsupported parameter' }),
        'application/json'
      ),
    /code=4001.*上游提示=unsupported parameter/
  );
});

test('LLM 完整耗时包含响应头之后的流式生成时间', async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.COZE_INTEGRATION_MODEL_BASE_URL;
  const originalApiKey = process.env.COZE_WORKLOAD_IDENTITY_API_KEY;
  process.env.COZE_INTEGRATION_MODEL_BASE_URL = 'https://model.example.test/v1';
  process.env.COZE_WORKLOAD_IDENTITY_API_KEY = 'test-key';
  const encoder = new TextEncoder();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"{\\"ok\\":"},"finish_reason":null}]}\n\n'
            )
          );
          setTimeout(() => {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
              )
            );
            controller.close();
          }, 30);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    );

  try {
    const result = await invokeChatCompletion({
      messages: [{ role: 'user', content: 'test' }],
      model: 'test-model',
      temperature: 0,
      maxOutputTokens: 100,
    });
    assert.equal(result.content, '{"ok":true}');
    assert.ok(result.diagnostics.durationMs >= 25);
    assert.ok(
      result.diagnostics.durationMs >
        (result.diagnostics.responseHeadersDurationMs ?? 0)
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.COZE_INTEGRATION_MODEL_BASE_URL;
    } else {
      process.env.COZE_INTEGRATION_MODEL_BASE_URL = originalBaseUrl;
    }
    if (originalApiKey === undefined) {
      delete process.env.COZE_WORKLOAD_IDENTITY_API_KEY;
    } else {
      process.env.COZE_WORKLOAD_IDENTITY_API_KEY = originalApiKey;
    }
  }
});
