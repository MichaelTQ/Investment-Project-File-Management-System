import { Config, type Message } from 'coze-coding-dev-sdk';

export interface ModelCallDiagnostics {
  model: string;
  inputCharacters: number;
  estimatedInputTokens: number;
  outputCharacters: number;
  outputTokens: number | null;
  finishReason: string | null;
  maxOutputTokens: number;
  durationMs: number;
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: { content?: string | null };
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
  code?: string | number;
  message?: string;
  data?: unknown;
}

export interface ChatCompletionResult {
  content: string;
  diagnostics: ModelCallDiagnostics;
}

export interface InvokeChatCompletionParams {
  messages: Message[];
  model: string;
  temperature: number;
  maxOutputTokens: number;
  customHeaders?: Record<string, string>;
  responseFormat?: 'json_object';
  timeoutMs?: number;
}

interface ParsedChatCompletion {
  content: string;
  outputTokens: number | null;
  promptTokens: number | null;
  finishReason: string | null;
}

function contentCharacters(content: Message['content']): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => {
    if (part.type === 'text') return total + (part.text?.length ?? 0);
    if (part.type === 'image_url') {
      const url = part.image_url?.url ?? '';
      // Data URL 会非常长，但其字符数不能代表视觉模型输入 token；只记录引用长度。
      return total + (url.startsWith('data:') ? 32 : url.length);
    }
    return total;
  }, 0);
}

export function messageCharacterCount(messages: Message[]): number {
  return messages.reduce(
    (total, message) => total + contentCharacters(message.content),
    0
  );
}

function asChatPayload(value: unknown): ChatCompletionsResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as ChatCompletionsResponse;
  if (
    payload.data &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data)
  ) {
    const nested = payload.data as ChatCompletionsResponse;
    if (nested.choices || nested.error || nested.usage) return nested;
  }
  return payload;
}

function responseShapeDiagnostic(
  payload: ChatCompletionsResponse | null,
  contentType: string,
  rawText: string
): string {
  const fields = payload ? Object.keys(payload).slice(0, 10).join(',') : '无';
  const upstreamMessage = payload?.error?.message ?? payload?.message;
  const code = payload?.code;
  return [
    `content-type=${contentType || '未知'}`,
    `响应长度=${rawText.length}`,
    `顶层字段=${fields || '无'}`,
    code === undefined ? '' : `code=${String(code)}`,
    upstreamMessage ? `上游提示=${upstreamMessage.slice(0, 300)}` : '',
  ]
    .filter(Boolean)
    .join('，');
}

/** 同时兼容 Coze 当前的 SSE 流式响应和标准非流式 Chat Completions。 */
export function parseChatCompletionResponse(
  rawText: string,
  contentType = ''
): ParsedChatCompletion {
  const looksLikeSse =
    contentType.toLowerCase().includes('text/event-stream') ||
    rawText.trimStart().startsWith('data:');
  let content = '';
  let outputTokens: number | null = null;
  let promptTokens: number | null = null;
  let finishReason: string | null = null;
  let sawChoice = false;
  let lastPayload: ChatCompletionsResponse | null = null;

  if (looksLikeSse) {
    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data);
      } catch {
        continue;
      }
      const payload = asChatPayload(decoded);
      if (!payload) continue;
      lastPayload = payload;
      if (payload.error) {
        throw new Error(`模型流式响应报错：${payload.error.message ?? '未知错误'}`);
      }
      const choice = payload.choices?.[0];
      if (choice) {
        sawChoice = true;
        content += choice.delta?.content ?? choice.message?.content ?? '';
        finishReason = choice.finish_reason ?? finishReason;
      }
      outputTokens = payload.usage?.completion_tokens ?? outputTokens;
      promptTokens = payload.usage?.prompt_tokens ?? promptTokens;
    }
  } else {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawText);
    } catch {
      decoded = null;
    }
    const payload = asChatPayload(decoded);
    lastPayload = payload;
    if (payload?.error) {
      throw new Error(`模型响应报错：${payload.error.message ?? '未知错误'}`);
    }
    const choice = payload?.choices?.[0];
    if (choice) {
      sawChoice = true;
      content = choice.message?.content ?? choice.delta?.content ?? '';
      finishReason = choice.finish_reason ?? null;
    }
    outputTokens = payload?.usage?.completion_tokens ?? null;
    promptTokens = payload?.usage?.prompt_tokens ?? null;
  }

  if (!sawChoice) {
    throw new Error(
      `模型响应中没有 choices[0]（${responseShapeDiagnostic(lastPayload, contentType, rawText)}）`
    );
  }
  return { content, outputTokens, promptTokens, finishReason };
}

export async function invokeChatCompletion(
  params: InvokeChatCompletionParams
): Promise<ChatCompletionResult> {
  const config = new Config({ timeout: params.timeoutMs ?? 120_000 });
  if (!config.modelBaseUrl) {
    throw new Error('缺少 COZE_INTEGRATION_MODEL_BASE_URL，无法调用模型');
  }
  if (!config.apiKey) {
    throw new Error('缺少 COZE_WORKLOAD_IDENTITY_API_KEY，无法调用模型');
  }

  const inputCharacters = messageCharacterCount(params.messages);
  const startedAt = Date.now();
  const response = await fetch(
    `${config.modelBaseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Client-Sdk': 'coze-coding-dev-sdk-typescript/0.3.0',
        ...(params.customHeaders ?? {}),
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature,
        // Coze 当前模型网关与 SDK 默认使用 SSE；保持流式协议后在本地聚合内容。
        stream: true,
        max_tokens: params.maxOutputTokens,
        ...(params.responseFormat
          ? { response_format: { type: params.responseFormat } }
          : {}),
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(config.timeout),
    }
  );
  const durationMs = Date.now() - startedAt;
  const contentType = response.headers.get('content-type') ?? '';
  const rawText = await response.text();
  if (!response.ok) {
    let payload: ChatCompletionsResponse | null = null;
    try {
      payload = asChatPayload(JSON.parse(rawText));
    } catch {
      payload = null;
    }
    throw new Error(
      `模型请求失败（HTTP ${response.status}，${durationMs}ms）：${payload?.error?.message ?? payload?.message ?? responseShapeDiagnostic(payload, contentType, rawText)}`
    );
  }

  const parsed = parseChatCompletionResponse(rawText, contentType);
  return {
    content: parsed.content,
    diagnostics: {
      model: params.model,
      inputCharacters,
      estimatedInputTokens:
        parsed.promptTokens ?? Math.ceil(inputCharacters / 2),
      outputCharacters: parsed.content.length,
      outputTokens: parsed.outputTokens,
      finishReason: parsed.finishReason,
      maxOutputTokens: params.maxOutputTokens,
      durationMs,
    },
  };
}
