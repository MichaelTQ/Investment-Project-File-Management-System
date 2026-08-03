import assert from 'node:assert/strict';
import test from 'node:test';

import { parseChatCompletionResponse } from '../src/lib/classification/chat-completions';

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
