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
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
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
        'X-Client-Sdk': 'investment-project-archive/2.0',
        ...(params.customHeaders ?? {}),
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature,
        stream: false,
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
  const payload = (await response.json().catch(() => ({}))) as ChatCompletionsResponse;
  if (!response.ok) {
    throw new Error(
      `模型请求失败（HTTP ${response.status}，${durationMs}ms）：${payload.error?.message ?? '上游未返回错误说明'}`
    );
  }

  const choice = payload.choices?.[0];
  if (!choice) throw new Error('模型响应中没有 choices[0]');
  const content = choice.message?.content ?? '';
  return {
    content,
    diagnostics: {
      model: params.model,
      inputCharacters,
      estimatedInputTokens:
        payload.usage?.prompt_tokens ?? Math.ceil(inputCharacters / 2),
      outputCharacters: content.length,
      outputTokens: payload.usage?.completion_tokens ?? null,
      finishReason: choice.finish_reason ?? null,
      maxOutputTokens: params.maxOutputTokens,
      durationMs,
    },
  };
}
