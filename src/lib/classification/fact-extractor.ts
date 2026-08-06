import {
  type LLMClient,
  type Message,
} from 'coze-coding-dev-sdk';

import {
  createFallbackDocumentFacts,
  DocumentFactsSchema,
  extractFirstJsonObject,
  hasContentEvidence,
  parseDocumentFactsResponse,
  type DocumentFacts,
  type DocumentFactsExtractionResult,
} from './document-facts';
import { documentTypeFromRawLabel } from './document-type-alias';
import {
  invokeChatCompletion,
  messageCharacterCount,
  type ModelCallDiagnostics,
} from './chat-completions';

const DOCUMENT_FACTS_CONTENT_LIMIT = 5_000;
// 这是护栏，不是省时手段：撞上它 JSON 必然截断，解析失败后整份事实退化为
// 只含文件名的空壳（createFallbackDocumentFacts），而且内容越丰富的文件越容易
// 触发——本该分得更准的文件反而退化。
// 取消逐字段条数上限后，信息量大的文件输出会变长（此前实测约 590 tokens），
// 因此这里从 900 抬到 1400 留足余量。压低它等于给丰富的文件判死刑。
export const DOCUMENT_FACTS_MAX_OUTPUT_TOKENS = 1_400;
const DOCUMENT_FACTS_TIMEOUT_MS = 120_000;
const DOCUMENT_FACTS_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const DOCUMENT_FACTS_CACHE_MAX_ENTRIES = 500;
export const DOCUMENT_FACTS_MODEL = 'doubao-seed-2-0-mini-260215';
/**
 * 抽取器版本。**改了提示词或后处理逻辑就必须改这里**——它是事实缓存键的一部分，
 * 不改的话旧结果会继续命中，改动等于没生效。
 *
 * v5：不再单凭模型自报的 sourceQuality 判定"读不到内容"。
 * v6：取消每个字段最多几条的限制（那些数字是拍脑袋定的，会静默丢掉信息量大的
 * 文件里的关键日期和字段变化），改为只约束 JSON 总长度；输出上限同步抬到 1400
 * tokens，否则放宽条数会更容易撞顶截断。
 * v7：要求每个日期在 meaning 末尾标出角色（本件形成／记载动作／制作载体／角色不明）。
 * 起因是一份 OA 流程截图：申请时间和十几天后的审批日志都记在同一份文件里，下游
 * 无从分辨哪个才是这份文件的时点，于是把流程日志当成文件日期，判出"申请晚于会议"
 * 的假矛盾；扫描件页脚的打印日期也是同一类坑。这四个角色是任何文档都有的属性，
 * 不认文件类型、不指向阶段。
 */
export const DOCUMENT_FACTS_EXTRACTOR_VERSION = 'document-facts-v7';

interface InvokeClient {
  // 与 LLMClient['invoke'] 兼容，但显式带上 finishReason：截断与其他失败必须能区分。
  invoke: (
    ...args: Parameters<LLMClient['invoke']>
  ) => Promise<{
    content: string;
    finishReason?: string | null;
    outputTokens?: number | null;
  }>;
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

function compactTupleList(value: unknown, width: number): unknown[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is unknown[] => Array.isArray(item))
    .map(item => item.slice(0, width));
}

/** 将模型使用的短字段协议还原为稳定的 DocumentFacts Schema。 */
export function parseCompactDocumentFactsResponse(content: string) {
  const json = extractFirstJsonObject(content);
  if (!json) return parseDocumentFactsResponse(content);
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return parseDocumentFactsResponse(content);
  }
  const compact = value as Record<string, unknown>;
  // 保持测试注入和旧缓存响应兼容。
  if ('schemaVersion' in compact || 'documentType' in compact) {
    return parseDocumentFactsResponse(content);
  }
  if (!('dt' in compact) || !('t' in compact) || !('q' in compact) || !('x' in compact)) {
    return parseDocumentFactsResponse(content);
  }
  const signStatus = {
    u: 'unsigned',
    i: 'signed',
    s: 'sealed',
    b: 'signed_and_sealed',
    x: 'unknown',
  }[String(compact.s ?? 'x')] ?? 'unknown';
  const sourceQuality = {
    t: 'text',
    v: 'visual_summary',
    i: 'image',
    f: 'filename_only',
    m: 'mixed',
  }[String(compact.q ?? 'f')] ?? 'filename_only';
  const dates = compactTupleList(compact.d, 3).map(item => ({
    date: item[0] ?? null,
    meaning: item[1] ?? '',
    evidence: item[2] ?? '',
  }));
  const parties = compactTupleList(compact.p, 2).map(item => ({
    name: item[0] ?? '',
    role: item[1] ?? '',
  }));
  const transactionChanges = compactTupleList(compact.c, 4).map(item => ({
    field: item[0] ?? '',
    before: item[1] ?? null,
    after: item[2] ?? null,
    evidence: item[3] ?? '',
  }));
  return parseDocumentFactsResponse(
    JSON.stringify({
      schemaVersion: 1,
      documentType: compact.dt ?? 'unknown',
      rawDocumentType: compact.r ?? '未知',
      title: compact.t ?? '未知文件',
      documentNumber: compact.n ?? null,
      version: compact.v ?? null,
      dates,
      parties,
      signStatus,
      transactionChanges,
      explicitStageClues: Array.isArray(compact.g) ? compact.g : [],
      evidenceQuotes: Array.isArray(compact.e) ? compact.e : [],
      warnings: Array.isArray(compact.w) ? compact.w : [],
      sourceQuality,
      extractionConfidence: compact.x ?? 0,
    })
  );
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
0. dt 必须从上面的枚举里选一个。只有连文件性质都看不出来时才用 unknown——
   标题或正文能看出它是决议、协议、章程、报告中的哪一种，就选最接近的枚举值。
   r 始终写文件自称的中文类型原文（如"股东会决议"），不要写"未知"。
1. 日期统一输出 YYYY-MM-DD；只有年份或月份时不要猜测日期，date 使用 null，并在 meaning 和 evidence 中记录原文。meaning 先照文件的说法写这是什么日期（签署日、生效日、缴款截止日等），再在末尾用方括号标出它的角色：[本件形成] 这个日期是本文件自身写成、签署或生效的时点；[记载动作] 这个日期是本文件记录的某件事发生或将要发生的时点，而不是本文件形成的时点；[制作载体] 这个日期来自打印、导出、扫描、下载等痕迹，与文件内容无关；[角色不明] 看不出来。照文件的说法仍要写，不要因为标了角色就省略。不要判断哪个日期更重要。
2. 主体名称尽量保留文件中的完整名称，并说明其在文件中的角色。
3. 文件写明了"某字段由 X 变为 Y"的，一律写入 transactionChanges，字段名照文件的写法。不限于金额类字段。
4. 签字和盖章只根据可见信息判断；无法判断时使用 unknown。
5. evidenceQuotes 只能包含当前输入中真实出现的短句或关键数据。
6. 如果内容来自扫描 PDF 视觉摘要，应将 sourceQuality 设为 visual_summary 或 mixed，并在 warnings 中说明信息可能不完整。
7. extractionConfidence 表示事实抽取完整度，不表示归档分类置信度。
8. d、p、c、g、e、w 必须始终输出数组；没有内容时输出 []，不得省略字段。
9. 文件里能核实的事实都写下来，不要为了精简而丢弃。日期有几个写几个，字段变化有几处写几处——判断文件属于哪个阶段靠的就是这些，少写一条可能正好少了决定性的那条。
10. 同一事实只能出现一次：已写入 dates 或 transactionChanges 的内容不要再复制到 explicitStageClues 或 evidenceQuotes。
11. 单项长度：变化前后值各不超过 60 字，证据和提示单项不超过 80 字。完整 JSON 控制在 1000 个字符以内——这不是精简要求，而是超长会撞上输出上限被截断，届时整份事实都会作废。信息量大的文件优先保证 d 和 c 写全，摘录可以少写。
12. 不要复述文档，不要输出分析过程或背景说明。必须使用下方短字段和数组元组，不得改成长字段对象。

只输出一个 JSON 对象，不要输出 Markdown或其他说明。短字段协议严格如下：
{
  "dt":"documentType枚举值","r":"中文类型或未知","t":"标题",
  "n":"编号或null","v":"版本或null",
  "d":[["YYYY-MM-DD或null","含义","证据"]],
  "p":[["主体全称","角色"]],
  "s":"u未签|i已签|s已盖章|b签字盖章|x未知",
  "c":[["变化字段","变化前或null","变化后或null","证据"]],
  "g":["明确业务动作"],"e":["关键证据"],"w":["风险"],
  "q":"t文字|v视觉摘要|i图片|f仅文件名|m混合","x":0到100整数
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

/**
 * 模型把类型填成 unknown，但自己在"原文表述"里写了中文类型名时，按中文名对回枚举。
 *
 * 实测的失败样本：一份股东会决议，标题、签署日期、字段的变更前后值全都抽对了，
 * documentType 却是 unknown——模型认得这份文件，只是没落到枚举上。
 *
 * 这里翻译的是模型已经写下的判断，不是新的推断，更不看文件名。
 */
function recoverDocumentTypeFromLabel(facts: DocumentFacts): DocumentFacts {
  if (facts.documentType !== 'unknown') return facts;
  // 确实什么都没读到时不做恢复，否则等于绕过下面那道闸。
  // 判据是有没有原文事实，不是模型自报的 sourceQuality——它经常报错。
  if (facts.sourceQuality === 'filename_only' && !hasContentEvidence(facts)) {
    return facts;
  }

  const recovered = documentTypeFromRawLabel(facts.rawDocumentType);
  return recovered ? { ...facts, documentType: recovered } : facts;
}

/**
 * 读不到内容时，不允许保留一个"看起来像样"的文件类型。
 *
 * 扫描件 OCR 失败、格式不支持、转图失败时，提示词里只剩文件名，模型仍会照着
 * 文件名给出 documentType。这种类型是猜的，但下游看不出来：它会照常参与同类型
 * 文件比对和阶段判断，只是额外挂一个人工复核标记——而复核标记不阻止归档建议产出。
 *
 * 所以在这里就地降级为 unknown，让它走"读不到内容"的分支，而不是走"读到了、
 * 类型是X"的分支。文件名本身仍保留在 title 里，人工复核时看得到。
 */
function enforceContentEvidence(facts: DocumentFacts): DocumentFacts {
  if (facts.sourceQuality !== 'filename_only') return facts;

  // 自报"只读到文件名"，却交出了日期、字段变更、原文摘录——自相矛盾，以产出为准。
  // 此前这里直接把类型作废，结果把模型正确识别出的类型销毁了，界面上大量 unknown
  // 都出自这条路径。现在只记一条提示，不动事实。
  if (hasContentEvidence(facts)) {
    return {
      ...facts,
      warnings: [
        ...facts.warnings,
        '模型自报只读到文件名，但同时给出了原文事实，已按读到内容处理。',
      ].slice(0, 3),
    };
  }

  if (facts.documentType === 'unknown') return facts;

  return {
    ...facts,
    documentType: 'unknown',
    rawDocumentType: '未知',
    warnings: [
      ...facts.warnings,
      `未能读取文件内容，模型仅凭文件名给出的类型“${facts.rawDocumentType}”已作废，需人工确认。`,
    ].slice(0, 3),
  };
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
        outputTokens: response.outputTokens ?? null,
        finishReason: response.finishReason ?? null,
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
      // 顺序：先按中文名补回类型，再过"读不到内容"的闸。闸必须在最后，
      // 否则文件名猜出来的类型会被恢复步骤救回去。
      facts: enforceContentEvidence(
        recoverDocumentTypeFromLabel(parseCompactDocumentFactsResponse(content))
      ),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Document facts extraction error:', error);
    // 输出撞上 max_tokens 时 JSON 必然不完整，解析必定失败。这类失败与超时、
    // 网络错误不同：模型其实已经写出了大部分事实，只是没写完整就被丢弃。
    // 单独标注，避免与"按策略触发的人工复核"在界面上无法区分。
    const truncated = modelCall?.finishReason === 'length';
    const warning = truncated
      ? `结构化事实抽取失败：模型输出达到 ${
          modelCall?.maxOutputTokens ?? DOCUMENT_FACTS_MAX_OUTPUT_TOKENS
        } tokens 上限被截断，已产出的事实无法解析而全部丢弃（${message}）`
      : `结构化事实抽取失败：${message}`;
    return {
      status: 'fallback',
      facts: createFallbackDocumentFacts(params.fileName, warning),
      error: warning,
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
