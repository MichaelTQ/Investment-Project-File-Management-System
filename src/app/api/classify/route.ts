import { NextRequest, NextResponse } from 'next/server';
import {
  LLMClient,
  FetchClient,
  Config,
  HeaderUtils,
  type ContentPart,
  type Message,
} from 'coze-coding-dev-sdk';
import { FLAT_FILE_CATEGORIES, type FlatFileCategory } from '@/lib/folder-structure';
import {
  assessKeywordMatches,
  getCategoryByLlmIndex,
  KEYWORD_SCORE_THRESHOLD,
  LLM_CONFIDENCE_THRESHOLD,
  matchByKeywords,
  normalizeConfidence,
} from '@/lib/classification';
import {
  DOCUMENT_FACTS_EXTRACTOR_VERSION,
  DOCUMENT_FACTS_MODEL,
  extractDocumentFacts,
} from '@/lib/classification/fact-extractor';
import type { DocumentFacts } from '@/lib/classification/document-facts';
import { getCategoryEvidencePolicy } from '@/lib/classification/category-policies';
import {
  decideWithProjectContext,
  parseProjectContextSnapshot,
  parseRelatedDocumentFacts,
  type ContextClassificationDecision,
  type ProjectContextSnapshot,
  type RelatedDocumentFacts,
} from '@/lib/classification/context-decision';
import {
  runClassificationAgent,
  type ClassificationAgentResult,
} from '@/lib/classification/classification-agent';
import {
  createClassificationDecisionRecord,
  linkDocumentFactToArchivedFile,
  upsertDocumentFactsRecord,
} from '@/lib/project-memory';
import {
  archiveFile,
  archiveStoredFile,
  getProject,
  getStoredFileUrl,
  readStoredFile,
  uploadTempFileFromBuffer,
} from '@/lib/storage';

export const runtime = 'nodejs';

/** 大文件阈值：超过此大小的 multipart 文件先上传 S3 临时目录，避免 Base64 膨胀导致 502 */
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

// 关键词匹配详情
interface KeywordMatchDetail {
  categoryName: string;
  folderPath: string[];
  score: number;
  matchedKeywords: string[];
  fileNameMatches: string[];
  contentMatches: string[];
}

// 分类过程详情
interface ClassifyProcess {
  step0_factExtraction?: {
    enabled: boolean;
    status: 'success' | 'fallback';
    error?: string;
    persistence?: {
      requested: boolean;
      status: 'success' | 'skipped' | 'failed';
      recordId?: string;
      error?: string;
      archivedFileLink?: 'success' | 'failed';
    };
  };
  step0_contextDecision?: {
    enabled: boolean;
    status: ContextClassificationDecision['status'];
    policyVersion: string;
    requiresHumanReview: boolean;
    inputWarnings?: string[];
  };
  step0_agentOrchestration?: {
    enabled: boolean;
    status: 'success' | 'failed';
    graphVersion?: string;
    finalStatus?: ClassificationAgentResult['status'];
    rounds?: number;
    toolSteps?: number;
    llmCallCount?: number;
    error?: string;
    inputWarnings?: string[];
  };
  step1_keywordMatch: {
    totalCategories: number;
    matchedCategories: number;
    details: KeywordMatchDetail[];
    bestMatch?: KeywordMatchDetail;
    threshold: number;
    scoreGap?: number;
    ambiguous?: boolean;
    passed: boolean;
  };
  step2_llmAnalysis?: {
    triggered: boolean;
    reason: string;
    result?: {
      categoryIndex: number | null;
      categoryName: string;
      confidence: number;
      reasoning: string;
      suggestedArchiveTitle: string;
    };
  };
  decisionPersistence?: {
    status: 'success' | 'failed';
    recordId?: string;
    error?: string;
  };
  finalDecision: {
    method: 'keyword' | 'llm' | 'fallback' | 'none';
    explanation: string;
  };
}

// 文件分类结果接口
interface ClassifyResult {
  fileName: string;
  fileSize: number;
  category: FlatFileCategory | null;
  confidence: number;
  reasoning: string;
  contentPreview?: string;
  process: ClassifyProcess;
  suggestedArchiveTitle?: string;
  documentFacts?: DocumentFacts;
  contextDecision?: ContextClassificationDecision;
  agentDecision?: ClassificationAgentResult;
  requiresArchiveConfirmation?: boolean;
  archived?: {
    id: string;
    archivedName: string;
    projectName: string;
    folderPath: string[];
  };
}

function parseOptionalJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const PDF_VISUAL_BATCH_SIZE = 4;
const PDF_VISUAL_MAX_PAGES = 12;

// 扫描 PDF 没有文字层时，将解析服务返回的页面图片分批交给多模态模型提取关键信息。
async function extractScannedPdfText(
  pageImageUrls: string[],
  fileName: string,
  customHeaders: Record<string, string>
): Promise<string> {
  const selectedUrls = pageImageUrls.slice(0, PDF_VISUAL_MAX_PAGES);
  if (selectedUrls.length === 0) return '';

  const batches: string[][] = [];
  for (let index = 0; index < selectedUrls.length; index += PDF_VISUAL_BATCH_SIZE) {
    batches.push(selectedUrls.slice(index, index + PDF_VISUAL_BATCH_SIZE));
  }

  const config = new Config();
  const client = new LLMClient(config, customHeaders);
  const batchResults = await Promise.all(
    batches.map(async (batch, batchIndex) => {
      const firstPage = batchIndex * PDF_VISUAL_BATCH_SIZE + 1;
      const content: ContentPart[] = [
        {
          type: 'text',
          text: `你正在读取扫描版PDF《${fileName}》的第${firstPage}至${firstPage + batch.length - 1}页。
请只提取图片中能够明确辨认的关键信息，包括：
1. 文件正式标题和文件类型
2. 公司、基金、协议方等主体全称
3. 日期、编号、版本、签署或盖章状态
4. 能帮助判断档案分类的章节标题和核心事项

不要猜测模糊文字，不要进行档案分类。请用简洁中文逐页概括。`,
        },
      ];

      batch.forEach((url, pageIndex) => {
        content.push(
          {
            type: 'text',
            text: `第${firstPage + pageIndex}页：`,
          },
          {
            type: 'image_url',
            image_url: { url, detail: 'high' },
          }
        );
      });

      try {
        const response = await client.invoke(
          [
            {
              role: 'system',
              content: '你是严谨的中文档案OCR助手，只记录图片中真实可见的信息。',
            },
            { role: 'user', content },
          ],
          {
            model: 'doubao-seed-2-0-lite-260215',
            temperature: 0.1,
          }
        );
        return response.content.trim();
      } catch (error) {
        console.error(`Scanned PDF batch ${batchIndex + 1} error:`, error);
        return '';
      }
    })
  );

  const extracted = batchResults.filter(Boolean);
  if (extracted.length === 0) return '';

  return `[扫描PDF视觉分析：共分析${selectedUrls.length}页]\n${extracted.join('\n\n')}`;
}

// 使用 LLM 进行智能分类
async function classifyWithLLM(
  fileName: string,
  contentText: string,
  projectName: string,
  customHeaders: Record<string, string>,
  imageDataUrl?: string
): Promise<{
  categoryIndex: number | null;
  category: FlatFileCategory | null;
  categoryName: string;
  confidence: number;
  reasoning: string;
  suggestedArchiveTitle: string;
}> {
  const config = new Config();
  const client = new LLMClient(config, customHeaders);

  const categoryOptions = FLAT_FILE_CATEGORIES.map((cat, index) =>
    `${index + 1}. ${cat.folderPath.join('/')} / ${cat.fileName} (关键词: ${cat.keywords.join(', ')})`
  ).join('\n');

  const systemPrompt = `你是一个专业的投资项目档案分类与命名助手。

你的任务包括：
1. 根据文件名、文件文字内容以及可能提供的图片，判断文件所属的档案分类
2. 为文件生成一个准确、清晰、方便检索的建议档案标题

以下是可选的归档位置：
${categoryOptions}

请严格从以上分类中选择，不得自行创造新的分类。

【分类规则】
1. 综合判断文件名、正文主题、文件结构和可见图片内容
2. 文件名只能作为线索，不能在文件内容与文件名冲突时盲目采用文件名
3. 如果提供图片，需要分析图片中的场景、主体、物体、印章、证件和可见文字
4. 选择语义最匹配的归档位置
5. 无法充分判断时降低置信度，不得编造内容

【建议档案标题规则】
建议标题必须比分类名称更具体。生成标题前，按以下顺序提取核心信息：
1. 文件编号、英文简称或封面标题，例如“NDA”“BP”“第8号决议”
2. 文件涉及的全部主体，例如目标公司、被投企业、协议双方、交易对方、基金或项目主体
3. 文件对应的业务期间，例如“2025年度”“2026年上半年”“2024-2026年”
4. 文件的具体事项，例如“A轮增资”“苏州工厂实地调研”“重大风险事件”
5. 文件类型，例如“财务尽调报告”“增资协议”“投委会决议”“保密协议”
6. 文件中明确出现的版本或状态，例如“签署版”“最终版”“修订版”

推荐标题结构：
文件编号或英文简称 + 非项目方核心主体 + 业务期间或关键事项 + 文件类型 + 明确的版本信息

【协议、合同及决议类文件的强制规则】
1. 必须识别封面、标题或正文中的文件编号、英文简称和签约主体
2. 将签约主体与当前项目名称“${projectName || '未提供'}”进行语义比较
3. 与当前项目名称相同或高度相关的主体可以省略，因为最终文件名会自动附加项目名称
4. 与当前项目名称不同的另一方主体必须保留，不得只输出“保密协议”“增资协议”等分类名称
5. 文件中明确出现“NDA”“BP”等编号或英文简称时，必须保留在建议标题中
6. 公司名称可以去掉“深圳”“北京”等行政区划前缀，但应保留足以识别主体的核心商号和公司性质
7. 默认按信息顺序直接拼接；只有信息边界不清晰时才使用短横线分隔

标题示例：
星云科技-2025年度财务尽调报告
远航医疗-A轮增资协议-签署版
华辰新能源-2026年上半年投后管理报告
星云科技-苏州工厂实地调研照片
远航医疗-重大风险事件处置方案
NDA国创致远私募股权基金管理有限公司保密协议

协议类示例：
当前项目名称为“君柔”，文件封面出现“编号：NDA”“深圳国创致远私募股权基金管理有限公司”“深圳君柔科技有限公司”“保密协议”时：
- “深圳君柔科技有限公司”与项目名称重复，应省略
- “深圳国创致远私募股权基金管理有限公司”是非项目方，应保留其核心主体名称
- “NDA”是明确编号，应保留
- 正确建议标题为“NDA国创致远私募股权基金管理有限公司保密协议”
- 错误建议标题为“保密协议”

生成标题时必须遵守：
1. 标题只能使用文件中真实存在的信息，不得猜测公司名称、年份、轮次、地点或版本
2. 公司全称过长时，可以保留核心商号和公司性质，但不得缩短到无法识别主体
3. 如果主体名称与当前项目名称“${projectName || '未提供'}”高度重复，可以不在建议标题中重复，因为系统会在最终文件名中自动添加项目名称
4. 如果文件涉及的主体与当前项目名称不同，应当保留该主体名称
5. 业务年份指文件内容对应的年份，不是上传时间或归档时间
6. 不包含系统归档日期和文件扩展名
7. 不使用 / \\ : * ? " < > | 等非法字符
8. 不机械复制“扫描件”“新建文档”“最终最终版”等无意义内容
9. 建议控制在15至40个字符，最长不得超过50个字符
10. 只要文件中存在可识别的编号、主体、期间、事项或版本，建议标题就不得仅等于分类名称
11. 只有文件中完全没有可核实的核心信息时，才允许使用所选分类名称

【输出前自检】
输出前必须检查 suggestedArchiveTitle：
1. 是否遗漏了文件中明确出现的编号或英文简称
2. 是否遗漏了与当前项目不同的公司、交易对方或协议另一方
3. 是否错误地只返回了分类名称
4. 是否包含了文件中不存在的猜测信息
如有任一问题，必须先重写标题再输出。

【输出要求】
只输出一个合法JSON对象，不要使用Markdown代码块，不要添加任何额外说明。

格式必须为：
{
  "categoryIndex": 对应归档位置的数字编号,
  "confidence": 0到100之间的数字,
  "reasoning": "说明分类依据，包括文件名、正文或图片中的关键信息",
  "suggestedArchiveTitle": "建议档案标题"
}`;

  const userPrompt = `请分析以下文件，选择归档分类并生成建议档案标题。

当前项目名称：
${projectName || '未提供'}

原始文件名：
${fileName}

提取到的文件内容（前2000字）：
${contentText.slice(0, 2000)}

${imageDataUrl
    ? '已附上原始图片。请结合图片中的场景、主体、物体、印章、证件和可见文字进行判断，并在理由中说明视觉依据。'
    : '本次没有提供图片，请根据文件名和提取到的文字判断。'}

请严格按照系统要求，只返回JSON对象。`;

  const userContent: Message['content'] = imageDataUrl
    ? [
        { type: 'text', text: userPrompt },
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
            detail: 'high',
          },
        },
      ]
    : userPrompt;

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: userContent,
    }
  ];

  try {
    const response = await client.invoke(messages, {
      model: 'doubao-seed-2-0-lite-260215',
      temperature: 0.3,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const { categoryIndex, category } = getCategoryByLlmIndex(
        parsed.categoryIndex
      );
      return {
        categoryIndex,
        category,
        categoryName: category?.fileName || '',
        confidence: normalizeConfidence(parsed.confidence),
        reasoning:
          typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
            ? parsed.reasoning.trim()
            : 'AI分析判断',
        suggestedArchiveTitle:
          typeof parsed.suggestedArchiveTitle === 'string'
            ? parsed.suggestedArchiveTitle.trim()
            : ''
      };
    }
  } catch (error) {
    console.error('LLM classification error:', error);
  }

  return {
    categoryIndex: null,
    category: null,
    categoryName: '',
    confidence: 0,
    reasoning: 'AI分类失败',
    suggestedArchiveTitle: ''
  };
}

export async function POST(request: NextRequest) {
  try {
    const isJsonRequest = request.headers
      .get('content-type')
      ?.includes('application/json');
    let file: File | null = null;
    let storageKey = '';
    let fileName = '';
    let fileSize = 0;
    let suppliedMimeType = '';
    let projectId = '';
    let sourcePath = '';
    let autoArchive = true;
    let extractFacts =
      globalThis.process.env.ENABLE_DOCUMENT_FACTS_SHADOW === 'true';
    let persistFacts =
      globalThis.process.env.PERSIST_PROJECT_MEMORY_SHADOW === 'true' ||
      globalThis.process.env.PERSIST_DOCUMENT_FACTS_SHADOW === 'true';
    let runContextDecision =
      globalThis.process.env.ENABLE_CONTEXT_DECISION_SHADOW === 'true';
    let runAgentDecision =
      globalThis.process.env.ENABLE_CLASSIFICATION_AGENT_SHADOW === 'true';
    let rawProjectContext: unknown;
    let rawRelatedDocumentFacts: unknown;

    if (isJsonRequest) {
      const body = await request.json();
      storageKey = typeof body.storageKey === 'string' ? body.storageKey : '';
      fileName = typeof body.fileName === 'string' ? body.fileName : '';
      fileSize = Number(body.fileSize || 0);
      suppliedMimeType =
        typeof body.mimeType === 'string' ? body.mimeType : '';
      projectId = typeof body.projectId === 'string' ? body.projectId : '';
      sourcePath =
        typeof body.sourcePath === 'string' ? body.sourcePath : fileName;
      autoArchive = body.autoArchive !== false;
      extractFacts =
        typeof body.extractFacts === 'boolean'
          ? body.extractFacts
          : extractFacts;
      persistFacts =
        typeof body.persistFacts === 'boolean'
          ? body.persistFacts
          : persistFacts;
      runContextDecision =
        typeof body.contextDecision === 'boolean'
          ? body.contextDecision
          : runContextDecision;
      runAgentDecision =
        typeof body.agentDecision === 'boolean'
          ? body.agentDecision
          : runAgentDecision;
      rawProjectContext = body.projectContext;
      rawRelatedDocumentFacts = body.relatedDocumentFacts;

      if (
        !storageKey ||
        !projectId ||
        !storageKey.startsWith(`uploads/${projectId}/`)
      ) {
        return NextResponse.json(
          { error: '无效的 S3 临时文件地址' },
          { status: 400 }
        );
      }
    } else {
      const formData = await request.formData();
      const formFile = formData.get('file');
      file = formFile instanceof File ? formFile : null;
      projectId = String(formData.get('projectId') || '');
      sourcePath = String(formData.get('sourcePath') || file?.name || '');
      autoArchive = formData.get('autoArchive') !== 'false';
      const extractFactsValue = formData.get('extractFacts');
      extractFacts =
        extractFactsValue === null
          ? extractFacts
          : extractFactsValue === 'true';
      const persistFactsValue = formData.get('persistFacts');
      persistFacts =
        persistFactsValue === null
          ? persistFacts
          : persistFactsValue === 'true';
      const contextDecisionValue = formData.get('contextDecision');
      runContextDecision =
        contextDecisionValue === null
          ? runContextDecision
          : contextDecisionValue === 'true';
      const agentDecisionValue = formData.get('agentDecision');
      runAgentDecision =
        agentDecisionValue === null
          ? runAgentDecision
          : agentDecisionValue === 'true';
      rawProjectContext = parseOptionalJson(formData.get('projectContext'));
      rawRelatedDocumentFacts = parseOptionalJson(
        formData.get('relatedDocumentFacts')
      );
      fileName = file?.name || '';
      fileSize = file?.size || 0;
      suppliedMimeType = file?.type || '';
    }

    if ((!file && !storageKey) || !fileName) {
      return NextResponse.json(
        { error: '未提供文件' },
        { status: 400 }
      );
    }

    // 持久化必须以结构化事实为输入，因此显式请求持久化时自动启用抽取。
    extractFacts =
      extractFacts || persistFacts || runContextDecision || runAgentDecision;

    const projectContext: ProjectContextSnapshot | null =
      parseProjectContextSnapshot(rawProjectContext);
    const relatedDocumentFacts: RelatedDocumentFacts[] =
      parseRelatedDocumentFacts(rawRelatedDocumentFacts);
    const contextInputWarnings: string[] = [];
    if (rawProjectContext !== undefined && !projectContext) {
      contextInputWarnings.push('项目上下文不符合 Schema，本次已忽略');
    }
    if (
      rawRelatedDocumentFacts !== undefined &&
      relatedDocumentFacts.length === 0
    ) {
      contextInputWarnings.push('关联文件事实不符合 Schema，本次已忽略');
    }

    const project = projectId ? await getProject(projectId) : null;

    // 提取请求头
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);

    let contentText = '';
    let contentPreview = '';
    let imageDataUrl: string | undefined;
    let fileBuffer: Buffer | undefined;

    try {
      const extension = fileName.split('.').pop()?.toLowerCase() || '';
      const mimeType = suppliedMimeType || getMimeType(extension);

      // 大文件（>5MB）的 multipart 上传：先上传 S3 临时目录，用签名 URL 替代 Base64 Data URL
      // 避免 Base64 膨胀（12MB → ~17MB 字符串）导致 FetchClient 超时 502
      const isLargeMultipart = !storageKey && file && fileSize > LARGE_FILE_THRESHOLD;
      if (isLargeMultipart && projectId) {
        const tempBuffer = Buffer.from(await file!.arrayBuffer());
        storageKey = await uploadTempFileFromBuffer({
          buffer: tempBuffer,
          fileName,
          mimeType,
          projectId,
        });
        fileBuffer = tempBuffer; // 缓存 buffer，后续归档时复用
      }

      const ensureFileBuffer = async () => {
        if (!fileBuffer) {
          fileBuffer = storageKey
            ? await readStoredFile(storageKey)
            : Buffer.from(await file!.arrayBuffer());
        }
        return fileBuffer;
      };

      if (['txt', 'md', 'csv', 'json', 'xml'].includes(extension)) {
        contentText = new TextDecoder('utf-8').decode(await ensureFileBuffer());
      } else if (isImageFile(extension)) {
        // S3 文件直接使用短期签名 URL，旧流程仍兼容 Data URL。
        imageDataUrl = storageKey
          ? await getStoredFileUrl(storageKey)
          : `data:${mimeType};base64,${(await ensureFileBuffer()).toString('base64')}`;
        contentText = `[图片文件] 格式: ${extension.toUpperCase()}, 文件名: ${fileName}。请结合原始图片的场景、物体和可见文字进行分类。`;
      } else {
        // 已上传文件通过签名 URL 交给解析服务，避免把大文件扩展成 Base64。
        const sourceUrl = storageKey
          ? await getStoredFileUrl(storageKey)
          : `data:${mimeType};base64,${(await ensureFileBuffer()).toString('base64')}`;

        const fetchConfig = new Config();
        const fetchClient = new FetchClient(fetchConfig, customHeaders);

        try {
          const fetchResponse = await fetchClient.fetch(sourceUrl);
          const textItems = fetchResponse.content.filter(item => item.type === 'text');
          contentText = textItems.map(item => item.text || '').join('\n');

          if (extension === 'pdf' && contentText.trim().length < 30) {
            const pageImageUrls = fetchResponse.content
              .filter(item => item.type === 'image')
              .map(item =>
                item.image?.image_url ||
                item.image?.display_url ||
                item.image?.thumbnail_display_url ||
                item.url ||
                ''
              )
              .filter((url): url is string => Boolean(url));

            const scannedText = await extractScannedPdfText(
              pageImageUrls,
              fileName,
              customHeaders
            );
            contentText = scannedText || fileName;
          }
        } catch (fetchError) {
          console.error('FetchClient error:', fetchError);
          contentText = fileName;
        }
      }

      contentPreview = contentText.slice(0, 500) + (contentText.length > 500 ? '...' : '');

    } catch (readError) {
      console.error('File read error:', readError);
      contentText = fileName;
    }

    // Shadow mode：先抽取结构化事实，但暂不改变当前分类和自动归档结论。
    let documentFacts: DocumentFacts | undefined;
    let persistedDocumentFactId: string | undefined;
    let factExtractionStep: ClassifyProcess['step0_factExtraction'];
    let contextClassificationDecision:
      | ContextClassificationDecision
      | undefined;
    let agentClassificationResult: ClassificationAgentResult | undefined;
    let agentOrchestrationStep:
      | ClassifyProcess['step0_agentOrchestration']
      | undefined;
    if (extractFacts) {
      const extraction = await extractDocumentFacts({
        fileName,
        contentText,
        projectName: project?.name || '',
        customHeaders,
        imageDataUrl,
      });
      documentFacts = extraction.facts;
      factExtractionStep = {
        enabled: true,
        status: extraction.status,
        error: extraction.error,
      };

      if (persistFacts) {
        if (!project) {
          factExtractionStep.persistence = {
            requested: true,
            status: 'skipped',
            error: '文档事实持久化需要有效的 projectId',
          };
        } else {
          try {
            const extension = fileName.split('.').pop()?.toLowerCase() || '';
            const mimeType = suppliedMimeType || getMimeType(extension);
            const persisted = await upsertDocumentFactsRecord({
              projectId: project.id,
              originalName: fileName,
              storageKey: storageKey || undefined,
              fileSize,
              mimeType,
              fileBuffer,
              facts: extraction.facts,
              extractionStatus: extraction.status,
              extractionError: extraction.error,
              extractorVersion: DOCUMENT_FACTS_EXTRACTOR_VERSION,
              modelVersion: DOCUMENT_FACTS_MODEL,
            });
            persistedDocumentFactId = persisted.id;
            factExtractionStep.persistence = {
              requested: true,
              status: 'success',
              recordId: persisted.id,
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : '未知错误';
            console.error('Document facts persistence error:', error);
            factExtractionStep.persistence = {
              requested: true,
              status: 'failed',
              error: message,
            };
          }
        }
      }
    }

    if (runContextDecision && documentFacts) {
      contextClassificationDecision = decideWithProjectContext({
        sourcePath: sourcePath || fileName,
        facts: documentFacts,
        projectContext,
        relatedDocuments: relatedDocumentFacts,
      });
    }

    if (runAgentDecision && documentFacts) {
      try {
        agentClassificationResult = await runClassificationAgent({
          sourcePath: sourcePath || fileName,
          facts: documentFacts,
          projectContext,
          availableRelatedDocuments: relatedDocumentFacts,
        });
        agentOrchestrationStep = {
          enabled: true,
          status: 'success',
          graphVersion: agentClassificationResult.graphVersion,
          finalStatus: agentClassificationResult.status,
          rounds: agentClassificationResult.rounds,
          toolSteps: agentClassificationResult.trace.length,
          llmCallCount: agentClassificationResult.llmCallCount,
          inputWarnings:
            contextInputWarnings.length > 0
              ? contextInputWarnings
              : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        console.error('Classification agent error:', error);
        agentOrchestrationStep = {
          enabled: true,
          status: 'failed',
          error: message,
          inputWarnings:
            contextInputWarnings.length > 0
              ? contextInputWarnings
              : undefined,
        };
      }
    }

    // 第一步：关键词快速匹配
    const keywordMatches = matchByKeywords(fileName, contentText);
    const keywordAssessment = assessKeywordMatches(keywordMatches);

    const keywordMatchDetails: KeywordMatchDetail[] = keywordMatches.slice(0, 5).map(m => ({
      categoryName: m.category.fileName,
      folderPath: m.category.folderPath,
      score: m.score,
      matchedKeywords: m.matchedKeywords,
      fileNameMatches: m.fileNameMatches,
      contentMatches: m.contentMatches
    }));

    const process: ClassifyProcess = {
      step0_factExtraction: factExtractionStep,
      step0_contextDecision: contextClassificationDecision
        ? {
            enabled: true,
            status: contextClassificationDecision.status,
            policyVersion: contextClassificationDecision.policyVersion,
            requiresHumanReview:
              contextClassificationDecision.requiresHumanReview,
            inputWarnings:
              contextInputWarnings.length > 0
                ? contextInputWarnings
                : undefined,
          }
        : undefined,
      step0_agentOrchestration: agentOrchestrationStep,
      step1_keywordMatch: {
        totalCategories: FLAT_FILE_CATEGORIES.length,
        matchedCategories: keywordMatches.length,
        details: keywordMatchDetails,
        bestMatch: keywordMatchDetails[0],
        threshold: KEYWORD_SCORE_THRESHOLD,
        scoreGap: keywordAssessment.scoreGap ?? undefined,
        ambiguous: keywordAssessment.ambiguous,
        passed: !imageDataUrl && keywordAssessment.passed
      },
      finalDecision: {
        method: 'none',
        explanation: ''
      }
    };

    let result: ClassifyResult;

    // 如果关键词匹配置信度高，直接返回
    if (!imageDataUrl && keywordAssessment.passed) {
      const bestMatch = keywordMatches[0];
      const evidencePolicy = getCategoryEvidencePolicy(
        bestMatch.category.folderId,
        bestMatch.category.fileName
      );
      const requiresPolicyReview =
        evidencePolicy?.defaultRequiresHumanReview ?? false;
      process.finalDecision = {
        method: 'keyword',
        explanation: requiresPolicyReview
          ? `关键词匹配得分 ${bestMatch.score} 分，选择「${bestMatch.category.fileName}」；该类别按证据策略需人工复核后归档`
          : `关键词匹配得分 ${bestMatch.score} 分，且领先候选类别 ${keywordAssessment.scoreGap ?? bestMatch.score} 分，直接使用关键词匹配结果`
      };

      result = {
        fileName,
        fileSize,
        category: bestMatch.category,
        confidence: Math.min(bestMatch.score * 10, 95),
        reasoning: `文件名和内容匹配关键词："${bestMatch.matchedKeywords.join('、')}"，归类到「${bestMatch.category.fileName}」`,
        contentPreview,
        process,
        requiresArchiveConfirmation: requiresPolicyReview
      };
    } else {
      // 第二步：使用 LLM 进行智能分析
      process.step2_llmAnalysis = {
        triggered: true,
        reason: imageDataUrl
          ? '检测到图片文件，需要 AI 分析画面内容和可见文字'
          : keywordAssessment.ambiguous
            ? `关键词最高分与次高分差距不足 ${keywordAssessment.scoreGap ?? 0} 分，存在多个相近类别，需要 AI 消歧`
          : `关键词匹配得分不足（最高 ${keywordMatches[0]?.score || 0} 分 < 阈值 ${KEYWORD_SCORE_THRESHOLD} 分），需要 AI 智能分析`
      };

      const llmResult = await classifyWithLLM(
        fileName,
        contentText,
        project?.name || '',
        customHeaders,
        imageDataUrl
      );

      process.step2_llmAnalysis.result = {
        categoryIndex: llmResult.categoryIndex,
        categoryName: llmResult.categoryName,
        confidence: llmResult.confidence,
        reasoning: llmResult.reasoning,
        suggestedArchiveTitle: llmResult.suggestedArchiveTitle,
      };

      if (
        llmResult.category &&
        llmResult.confidence >= LLM_CONFIDENCE_THRESHOLD
      ) {
        const finalCategory = llmResult.category;

        process.finalDecision = {
          method: 'llm',
          explanation: `AI 分析置信度 ${llmResult.confidence}%，选择「${llmResult.categoryName}」作为归档位置；请确认分类位置和建议名称后归档`
        };

        result = {
          fileName,
          fileSize,
          category: finalCategory,
          confidence: llmResult.confidence,
          reasoning: llmResult.reasoning,
          contentPreview,
          process,
          suggestedArchiveTitle:
            llmResult.suggestedArchiveTitle || finalCategory?.fileName || '',
          requiresArchiveConfirmation: Boolean(finalCategory)
        };
      } else if (keywordMatches.length > 0) {
        process.finalDecision = {
          method: 'fallback',
          explanation: `AI 分析置信度不足（${llmResult.confidence}% < ${LLM_CONFIDENCE_THRESHOLD}%），暂用关键词最佳结果；归档前必须人工确认分类位置`
        };

        result = {
          fileName,
          fileSize,
          category: keywordMatches[0].category,
          confidence: Math.min(keywordMatches[0].score * 10, 95),
          reasoning: `根据关键词匹配，归类到「${keywordMatches[0].category.fileName}」`,
          contentPreview,
          process,
          suggestedArchiveTitle: keywordMatches[0].category.fileName,
          requiresArchiveConfirmation: true
        };
      } else {
        process.finalDecision = {
          method: 'none',
          explanation: '关键词匹配和 AI 分析均无法确定分类，需要手动分类'
        };

        result = {
          fileName,
          fileSize,
          category: null,
          confidence: 0,
          reasoning: '无法确定文件归档位置，请手动分类。文件内容未匹配任何已知分类关键词。',
          contentPreview,
          process
        };
      }
    }

    if (documentFacts) result.documentFacts = documentFacts;
    if (contextClassificationDecision) {
      result.contextDecision = contextClassificationDecision;
    }
    if (agentClassificationResult) {
      result.agentDecision = agentClassificationResult;
    }

    // 自动归档
    if (
      autoArchive &&
      projectId &&
      result.category &&
      !result.requiresArchiveConfirmation
    ) {
      if (project) {
        const extension = fileName.split('.').pop()?.toLowerCase() || '';
        const mimeType = suppliedMimeType || getMimeType(extension);
        const archived = storageKey
          ? await archiveStoredFile({
              storageKey,
              originalName: fileName,
              fileSize,
              projectId,
              projectName: project.name,
              categoryId: result.category.folderId,
              categoryName: result.category.fileName,
              folderPath: result.category.folderPath,
              mimeType,
              confidence: result.confidence,
              reasoning: result.reasoning,
            })
          : await archiveFile({
              fileBuffer:
                fileBuffer || Buffer.from(await file!.arrayBuffer()),
              originalName: fileName,
              projectId,
              projectName: project.name,
              categoryId: result.category.folderId,
              categoryName: result.category.fileName,
              folderPath: result.category.folderPath,
              mimeType,
              confidence: result.confidence,
              reasoning: result.reasoning,
            });

        result.archived = {
          id: archived.id,
          archivedName: archived.archivedName,
          projectName: project.name,
          folderPath: archived.folderPath
        };

        if (persistedDocumentFactId && factExtractionStep?.persistence) {
          try {
            await linkDocumentFactToArchivedFile(
              persistedDocumentFactId,
              archived.id
            );
            factExtractionStep.persistence.archivedFileLink = 'success';
          } catch (error) {
            console.error('Document fact archive link error:', error);
            factExtractionStep.persistence.archivedFileLink = 'failed';
          }
        }
      }
    }

    // 记录当前 legacy 分类器的 shadow 决策，用于后续与上下文分类器对比。
    if (persistFacts && project) {
      try {
        const decisionId = await createClassificationDecisionRecord({
          projectId: project.id,
          archivedFileId: result.archived?.id,
          documentFactId: persistedDocumentFactId,
          selectedCategoryId: result.category?.folderId,
          selectedCategoryName: result.category?.fileName,
          selectedFolderPath: result.category?.folderPath,
          candidateCategories: keywordMatchDetails.map(candidate => ({
            categoryName: candidate.categoryName,
            folderPath: candidate.folderPath,
            score: candidate.score,
            matchedKeywords: candidate.matchedKeywords,
          })),
          evidence: [
            ...(documentFacts?.evidenceQuotes ?? []),
            ...keywordMatchDetails[0]?.matchedKeywords.map(
              keyword => `关键词命中：${keyword}`
            ) ?? [],
          ],
          contradictions: [],
          decisionScore: result.confidence,
          decisionSource: process.finalDecision.method,
          reasoning: result.reasoning,
          modelVersion:
            process.finalDecision.method === 'llm' ||
            process.finalDecision.method === 'fallback'
              ? 'doubao-seed-2-0-lite-260215'
              : undefined,
          policyVersion: 'legacy-classification-v1',
          requiresReview:
            Boolean(result.requiresArchiveConfirmation) || !result.category,
        });
        process.decisionPersistence = {
          status: 'success',
          recordId: decisionId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        console.error('Classification decision persistence error:', error);
        process.decisionPersistence = {
          status: 'failed',
          error: message,
        };
      }
    }

    return NextResponse.json(result);

  } catch (error) {
    console.error('Classification error:', error);
    return NextResponse.json(
      {
        error: '文件处理失败',
        details: error instanceof Error ? error.message : '未知错误'
      },
      { status: 500 }
    );
  }
}

// 获取 MIME 类型
function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'json': 'application/json',
    'xml': 'application/xml',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
  };

  return mimeTypes[extension] || 'application/octet-stream';
}

// 判断是否为图片格式
function isImageFile(extension: string): boolean {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(extension);
}
