import {
  type LLMClient,
  type Message,
} from 'coze-coding-dev-sdk';

import {
  createFallbackDocumentFacts,
  DocumentFactsSchema,
  parseDocumentFactsResponse,
  type DocumentFactsExtractionResult,
} from './document-facts';
import {
  invokeChatCompletion,
  messageCharacterCount,
  type ModelCallDiagnostics,
} from './chat-completions';

const DOCUMENT_FACTS_CONTENT_LIMIT = 6_000;
export const DOCUMENT_FACTS_MAX_OUTPUT_TOKENS = 1_200;
const DOCUMENT_FACTS_TIMEOUT_MS = 120_000;
const DOCUMENT_FACTS_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const DOCUMENT_FACTS_CACHE_MAX_ENTRIES = 500;
export const DOCUMENT_FACTS_MODEL = 'doubao-seed-2-0-lite-260215';
export const DOCUMENT_FACTS_EXTRACTOR_VERSION = 'document-facts-v2';

interface InvokeClient {
  invoke: LLMClient['invoke'];
}

export interface ExtractDocumentFactsParams {
  fileName: string;
  contentText: string;
  projectName: string;
  customHeaders: Record<string, string>;
  imageDataUrl?: string;
  client?: InvokeClient;
  cacheKey?: string;
}

interface CachedDocumentFacts {
  facts: DocumentFactsExtractionResult['facts'];
  cachedAt: number;
}

type RuntimeWithDocumentFactsCache = typeof globalThis & {
  __documentFactsExtractionCache?: Map<string, CachedDocumentFacts>;
  __documentFactsExtractionInFlight?: Map<
    string,
    Promise<DocumentFactsExtractionResult>
  >;
};

function factsCache() {
  const runtime = globalThis as RuntimeWithDocumentFactsCache;
  runtime.__documentFactsExtractionCache ??= new Map();
  runtime.__documentFactsExtractionInFlight ??= new Map();
  return {
    values: runtime.__documentFactsExtractionCache,
    inFlight: runtime.__documentFactsExtractionInFlight,
  };
}

function versionedCacheKey(cacheKey: string): string {
  return `${DOCUMENT_FACTS_EXTRACTOR_VERSION}:${DOCUMENT_FACTS_MODEL}:${cacheKey}`;
}

function pruneFactsCache(now: number): void {
  const cache = factsCache().values;
  for (const [key, value] of cache) {
    if (now - value.cachedAt > DOCUMENT_FACTS_CACHE_TTL_MS) cache.delete(key);
  }
  if (cache.size <= DOCUMENT_FACTS_CACHE_MAX_ENTRIES) return;
  const oldest = [...cache.entries()].sort(
    (left, right) => left[1].cachedAt - right[1].cachedAt
  );
  for (const [key] of oldest.slice(
    0,
    cache.size - DOCUMENT_FACTS_CACHE_MAX_ENTRIES
  )) {
    cache.delete(key);
  }
}

export function getCachedDocumentFacts(
  cacheKey: string | undefined
): DocumentFactsExtractionResult | null {
  if (!cacheKey) return null;
  const now = Date.now();
  pruneFactsCache(now);
  const cached = factsCache().values.get(versionedCacheKey(cacheKey));
  if (!cached) return null;
  return {
    status: 'success',
    facts: DocumentFactsSchema.parse(cached.facts),
    cacheHit: true,
  };
}

export function clearDocumentFactsCacheForTests(): void {
  const cache = factsCache();
  cache.values.clear();
  cache.inFlight.clear();
}

export function buildDocumentFactsPrompt(params: {
  fileName: string;
  contentText: string;
  projectName: string;
  imageDataUrl?: string;
}): Message[] {
  const systemPrompt = `你是严谨的投资项目档案事实抽取器。

你的唯一任务是从当前文件中提取可以核实的客观事实。不要选择归档目录，不要判断最终投资阶段，不要根据常识补全缺失信息。

【documentType 可选值】
company_charter, capital_increase_agreement, shareholder_agreement,
shareholder_resolution, board_resolution, investment_committee_resolution,
payment_notice, closing_confirmation, bank_receipt, due_diligence_report,
business_plan, project_initiation_report, project_initiation_application,
meeting_minutes, voting_result, investment_recommendation,
investment_compliance_review, business_license, financial_statement,
credit_report, confidentiality_agreement, capital_contribution_certificate,
shareholder_register, other, unknown

【抽取要求】
1. 日期统一输出 YYYY-MM-DD；只有年份或月份时不要猜测日期，date 使用 null，并在 meaning 和 evidence 中记录原文。
2. 主体名称尽量保留文件中的完整名称，并说明其在文件中的角色。
3. 注册资本、投资金额、股东、持股比例等前后变化写入 transactionChanges。
4. 签字和盖章只根据可见信息判断；无法判断时使用 unknown。
5. evidenceQuotes 只能包含当前输入中真实出现的短句或关键数据。
6. 如果内容来自扫描 PDF 视觉摘要，应将 sourceQuality 设为 visual_summary 或 mixed，并在 warnings 中说明信息可能不完整。
7. extractionConfidence 表示事实抽取完整度，不表示归档分类置信度。
8. dates、parties、transactionChanges、explicitStageClues、evidenceQuotes、warnings 必须始终输出数组；没有内容时输出 []，不得省略字段。
9. 只输出后续阶段判断真正需要的最小事实集合。最多输出 dates 4项、parties 8项、transactionChanges 6项、explicitStageClues 4项、evidenceQuotes 4项、warnings 3项。
10. 同一事实只能出现一次：已写入 dates 或 transactionChanges 的内容不要再复制到 explicitStageClues 或 evidenceQuotes。只保留最有区分力的原文证据。
11. transactionChanges 的 before 和 after 各不超过 100 字；其他证据和提示单项不超过 120 字。完整 JSON 目标不超过 1000 个汉字。
12. 不要复述文档，不要输出分析过程或背景说明。输出无 Markdown、无缩进的紧凑 JSON。

只输出一个 JSON 对象，不要输出 Markdown 或其他说明。JSON 必须严格符合：
{
  "schemaVersion": 1,
  "documentType": "上述枚举值",
  "rawDocumentType": "文件中的中文类型名称，无法判断填未知",
  "title": "文件正式标题，无法识别时使用原文件名主体",
  "documentNumber": "编号或null",
  "version": "版本或null",
  "dates": [{"date":"YYYY-MM-DD或null","meaning":"日期含义","evidence":"原文证据"}],
  "parties": [{"name":"主体全称","role":"主体角色"}],
  "signStatus": "unsigned|signed|sealed|signed_and_sealed|unknown",
  "transactionChanges": [{"field":"变化字段","before":"变化前或null","after":"变化后或null","evidence":"证据"}],
  "explicitStageClues": ["文件中明确出现的业务动作，不是最终分类"],
  "evidenceQuotes": ["可核实的短句或关键数据"],
  "warnings": ["缺失信息或识别风险"],
  "sourceQuality": "text|visual_summary|image|filename_only|mixed",
  "extractionConfidence": 0到100之间的整数
}`;

  const userPrompt = `当前项目名称（仅用于识别相关主体，不得用于推断阶段）：
${params.projectName || '未提供'}

原始文件名：
${params.fileName}

提取到的文件内容：
${params.contentText.slice(0, DOCUMENT_FACTS_CONTENT_LIMIT) || '[没有提取到文字]'}

${params.imageDataUrl
    ? '同时附有原始图片。请结合可见文字、签名和印章提取事实。'
    : '没有附加原始图片，只能使用文件名和上述文字。'}`;

  const userContent: Message['content'] = params.imageDataUrl
    ? [
        { type: 'text', text: userPrompt },
        {
          type: 'image_url',
          image_url: { url: params.imageDataUrl, detail: 'high' },
        },
      ]
    : userPrompt;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

async function extractDocumentFactsUncached(
  params: ExtractDocumentFactsParams
): Promise<DocumentFactsExtractionResult> {
  const messages = buildDocumentFactsPrompt({
    fileName: params.fileName,
    contentText: params.contentText,
    projectName: params.projectName,
    imageDataUrl: params.imageDataUrl,
  });
  let modelCall: ModelCallDiagnostics | undefined;

  try {
    let content: string;
    if (params.client) {
      const startedAt = Date.now();
      const response = await params.client.invoke(messages, {
        model: DOCUMENT_FACTS_MODEL,
        temperature: 0.1,
      });
      content = response.content;
      const inputCharacters = messageCharacterCount(messages);
      modelCall = {
        model: DOCUMENT_FACTS_MODEL,
        inputCharacters,
        estimatedInputTokens: Math.ceil(inputCharacters / 2),
        outputCharacters: content.length,
        outputTokens: null,
        finishReason: null,
        maxOutputTokens: DOCUMENT_FACTS_MAX_OUTPUT_TOKENS,
        durationMs: Date.now() - startedAt,
      };
    } else {
      const response = await invokeChatCompletion({
        messages,
        model: DOCUMENT_FACTS_MODEL,
        temperature: 0.1,
        maxOutputTokens: DOCUMENT_FACTS_MAX_OUTPUT_TOKENS,
        customHeaders: params.customHeaders,
        responseFormat: 'json_object',
        timeoutMs: DOCUMENT_FACTS_TIMEOUT_MS,
      });
      content = response.content;
      modelCall = response.diagnostics;
    }
    return {
      status: 'success',
      facts: parseDocumentFactsResponse(content),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Document facts extraction error:', error);
    return {
      status: 'fallback',
      facts: createFallbackDocumentFacts(
        params.fileName,
        `结构化事实抽取失败：${message}`
      ),
      error: message,
      modelCall,
    };
  }
}

export async function extractDocumentFacts(
  params: ExtractDocumentFactsParams
): Promise<DocumentFactsExtractionResult> {
  const cached = getCachedDocumentFacts(params.cacheKey);
  if (cached) return cached;
  if (!params.cacheKey) return extractDocumentFactsUncached(params);

  const key = versionedCacheKey(params.cacheKey);
  const cache = factsCache();
  const inFlight = cache.inFlight.get(key);
  if (inFlight) {
    const result = await inFlight;
    return result.status === 'success' ? { ...result, cacheHit: true } : result;
  }

  const task = extractDocumentFactsUncached(params);
  cache.inFlight.set(key, task);
  try {
    const result = await task;
    if (result.status === 'success') {
      cache.values.set(key, {
        facts: DocumentFactsSchema.parse(result.facts),
        cachedAt: Date.now(),
      });
      pruneFactsCache(Date.now());
    }
    return result;
  } finally {
    cache.inFlight.delete(key);
  }
}
