import { NextRequest, NextResponse } from 'next/server';
import {
  FetchClient,
  Config,
  HeaderUtils,
  type ContentPart,
} from 'coze-coding-dev-sdk';
import type { ArchiveFolder } from '@/lib/folder-structure';
import {
  DOCUMENT_FACTS_EXTRACTOR_VERSION,
  DOCUMENT_FACTS_MODEL,
  extractDocumentFacts,
  getCachedDocumentFacts,
} from '@/lib/classification/fact-extractor';
import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from '@/lib/classification/chat-completions';
import type { DocumentFacts } from '@/lib/classification/document-facts';
import {
  classifyWithMinimalPath,
  type MinimalClassifyResult,
} from '@/lib/classification/minimal/pipeline';
import { extractLocalPdfText } from '@/lib/classification/local-pdf-text';
import {
  createClassificationDecisionRecord,
  createDocumentFingerprint,
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

interface PhaseTiming {
  phase: string;
  durationMs: number;
  parentPhase?: string;
}

interface ProcessingPerformance {
  totalDurationMs: number;
  phases: PhaseTiming[];
  modelCalls: ModelCallDiagnostics[];
}

// 分类过程详情
interface ClassifyProcess {
  step0_factExtraction?: {
    enabled: boolean;
    status: 'success' | 'fallback';
    error?: string;
    modelCall?: ModelCallDiagnostics;
    cacheHit?: boolean;
    persistence?: {
      requested: boolean;
      status: 'success' | 'skipped' | 'failed';
      recordId?: string;
      error?: string;
      archivedFileLink?: 'success' | 'failed';
    };
  };
  step0_minimalPath?: {
    enabled: boolean;
    status: MinimalClassifyResult['status'];
    error?: string;
    modelCall?: ModelCallDiagnostics;
  };
  decisionPersistence?: {
    status: 'success' | 'failed';
    recordId?: string;
    error?: string;
  };
  finalDecision: {
    method: 'minimal' | 'none';
    explanation: string;
  };
}

// 文件分类结果接口
interface ClassifyResult {
  fileName: string;
  fileSize: number;
  targetFolder: ArchiveFolder | null;
  reasoning: string;
  contentPreview?: string;
  process: ClassifyProcess;
  classificationMode: 'minimal';
  businessStage?: string | null;
  documentType?: string;
  suggestedArchiveTitle?: string;
  documentFacts?: DocumentFacts;
  /** 极简链路的结论，与 Agent 链路并行运行、互不影响，用于 A/B 对照。 */
  minimalDecision?: MinimalClassifyResult;
  requiresArchiveConfirmation?: boolean;
  archived?: {
    id: string;
    archivedName: string;
    projectName: string;
    folderPath: string[];
  };
  performance?: ProcessingPerformance;
  contextRebuildPending?: boolean;
}

/**
 * 扫描件 OCR 的三个旋钮，都可以用环境变量调，方便直接 A/B 不用改代码。
 *
 * PDF_VISUAL_BATCH_SIZE：每次调用塞几页。**调小反而更快**——各批是并行的，
 * 总耗时取决于最慢的一批，一批 6 页当然比一批 3 页慢。调大省的是调用次数
 * （成本），不是等待时间。
 *
 * PDF_VISUAL_DETAIL：视觉精度。high 是每页上千视觉 token 的主要来源，扫描件
 * 小字靠它才读得准；low 能把 token 降一个量级，速度提升明显，但可能读错数字。
 * 当前默认 low，正在实测识别率是否够用；金额小数位或日期一旦读错就改回 high。
 *
 * PDF_VISUAL_MAX_PAGES：最多读几页，从第一页开始截。超出的页数完全不会被模型
 * 看到——20 页的文件现在只读前 12 页，后 8 页等于不存在。
 */
function envInt(name: string, fallback: number): number {
  const parsed = Number(globalThis.process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const PDF_VISUAL_BATCH_SIZE = envInt('PDF_VISUAL_BATCH_SIZE', 4);
const PDF_VISUAL_MAX_PAGES = envInt('PDF_VISUAL_MAX_PAGES', 12);
// 默认 low：先按低精度实测一轮，看关键数字（金额小数位、日期）读不读得准。
// 读错就把这里改回 'high'，或设环境变量 PDF_VISUAL_DETAIL=high。
const PDF_VISUAL_DETAIL: 'high' | 'low' =
  globalThis.process.env.PDF_VISUAL_DETAIL === 'high' ? 'high' : 'low';

// 启动时打印一次。环境变量是在模块加载时读的，服务不重启就不会生效——
// 没有这行日志，改没改成只能靠猜 OCR 质量，很容易测了半天其实一直是旧值。
console.log(
  `[OCR] detail=${PDF_VISUAL_DETAIL} batch=${PDF_VISUAL_BATCH_SIZE} maxPages=${PDF_VISUAL_MAX_PAGES}`
);

// 扫描 PDF 没有文字层时，将解析服务返回的页面图片分批交给多模态模型提取关键信息。
async function extractScannedPdfText(
  pageImageUrls: string[],
  fileName: string,
  customHeaders: Record<string, string>
): Promise<{ text: string; modelCalls: ModelCallDiagnostics[] }> {
  const selectedUrls = pageImageUrls.slice(0, PDF_VISUAL_MAX_PAGES);
  if (selectedUrls.length === 0) return { text: '', modelCalls: [] };

  const batches: string[][] = [];
  for (let index = 0; index < selectedUrls.length; index += PDF_VISUAL_BATCH_SIZE) {
    batches.push(selectedUrls.slice(index, index + PDF_VISUAL_BATCH_SIZE));
  }

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
4. 注册资本总额、股东名称、认缴金额、持股比例，以及“由/增加至/变更为”等交易前后变化
5. 能帮助识别文件客观类型和交易事实的章节标题与核心事项

不要猜测模糊文字，不要进行档案分类，不要复述无关正文。每页最多120个汉字，使用紧凑纯文本。`,
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
            image_url: { url, detail: PDF_VISUAL_DETAIL },
          }
        );
      });

      try {
        const response = await invokeChatCompletion({
          messages: [
            {
              role: 'system',
              content: '你是严谨的中文档案OCR助手，只记录图片中真实可见的信息。',
            },
            { role: 'user', content },
          ],
          model: 'doubao-seed-2-0-lite-260215',
          temperature: 0.1,
          maxOutputTokens: 1_200,
          customHeaders,
          timeoutMs: 120_000,
        });
        return {
          text: response.content.trim(),
          modelCall: response.diagnostics,
        };
      } catch (error) {
        console.error(`Scanned PDF batch ${batchIndex + 1} error:`, error);
        return { text: '', modelCall: null };
      }
    })
  );

  const extracted = batchResults.map(result => result.text).filter(Boolean);
  const modelCalls = batchResults.flatMap(result =>
    result.modelCall ? [result.modelCall] : []
  );
  if (extracted.length === 0) return { text: '', modelCalls };

  return {
    text: `[扫描PDF视觉分析：共分析${selectedUrls.length}页]\n${extracted.join('\n\n')}`,
    modelCalls,
  };
}

// 使用 LLM 进行智能分类
export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();
  const phaseTimings: PhaseTiming[] = [];
  const modelCalls: ModelCallDiagnostics[] = [];
  const measurePhase = async <T>(
    phase: string,
    action: () => Promise<T>,
    parentPhase?: string
  ) => {
    const startedAt = Date.now();
    try {
      return await action();
    } finally {
      phaseTimings.push({
        phase,
        durationMs: Date.now() - startedAt,
        parentPhase,
      });
    }
  };
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
    const runMinimalPath = true;

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

    // 极简分类始终依赖结构化事实，并始终保留人工确认。
    autoArchive = false;
    extractFacts =
      extractFacts ||
      persistFacts ||
      runMinimalPath;

    const project = projectId
      ? await measurePhase('load_project', () => getProject(projectId))
      : null;

    // 提取请求头
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);

    let contentText = '';
    let contentPreview = '';
    let imageDataUrl: string | undefined;
    let fileBuffer: Buffer | undefined;
    const extension = fileName.split('.').pop()?.toLowerCase() || '';
    const mimeType = suppliedMimeType || getMimeType(extension);

    if (file) {
      fileBuffer = await measurePhase('prepare_file_buffer', async () =>
        Buffer.from(await file!.arrayBuffer())
      );
    }
    const fingerprint = createDocumentFingerprint({
      fileBuffer,
      storageKey: storageKey || undefined,
      originalName: fileName,
      fileSize,
      mimeType,
    });
    const factCacheKey = `${projectId || 'unscoped'}:${fingerprint.kind}:${fingerprint.value}`;
    const cachedExtraction = extractFacts
      ? getCachedDocumentFacts(factCacheKey)
      : null;
    const canSkipContentParsing = Boolean(cachedExtraction);

    if (canSkipContentParsing) {
      contentText = '[相同文件事实已从进程缓存复用，跳过重复文件解析]';
      contentPreview = contentText;
      phaseTimings.push({ phase: 'read_and_parse_file', durationMs: 0 });
      phaseTimings.push({
        phase: 'reuse_document_facts_cache',
        durationMs: 0,
        parentPhase: 'read_and_parse_file',
      });
    } else {
      await measurePhase('read_and_parse_file', async () => {
        try {
      // 大文件（>5MB）的 multipart 上传：先上传 S3 临时目录，用签名 URL 替代 Base64 Data URL
      // 避免 Base64 膨胀（12MB → ~17MB 字符串）导致 FetchClient 超时 502
      const isLargeMultipart = !storageKey && file && fileSize > LARGE_FILE_THRESHOLD;
      if (isLargeMultipart && projectId) {
        storageKey = await measurePhase(
          'upload_temporary_file',
          () =>
            uploadTempFileFromBuffer({
              buffer: fileBuffer!,
              fileName,
              mimeType,
              projectId,
            }),
          'read_and_parse_file'
        );
      }

      const ensureFileBuffer = async () => {
        if (!fileBuffer) {
          fileBuffer = await measurePhase(
            'read_file_buffer',
            () =>
              storageKey
                ? readStoredFile(storageKey)
                : file!.arrayBuffer().then(value => Buffer.from(value)),
            'read_and_parse_file'
          );
        }
        return fileBuffer!;
      };

      if (['txt', 'md', 'csv', 'json', 'xml'].includes(extension)) {
        contentText = new TextDecoder('utf-8').decode(await ensureFileBuffer());
      } else if (isImageFile(extension)) {
        // S3 文件直接使用短期签名 URL，旧流程仍兼容 Data URL。
        imageDataUrl = storageKey
          ? await measurePhase(
              'generate_signed_file_url',
              () => getStoredFileUrl(storageKey),
              'read_and_parse_file'
            )
          : `data:${mimeType};base64,${(await ensureFileBuffer()).toString('base64')}`;
        contentText = `[图片文件] 格式: ${extension.toUpperCase()}, 文件名: ${fileName}。请结合原始图片的场景、物体和可见文字进行分类。`;
      } else {
        // 签名 URL 只依赖 storageKey，和读取文件内容互不依赖。提前并行发起，
        // 这样扫描件回退到 Coze 解析时不必再串行等一次往返。带文字层的 PDF
        // 用不到它，多出的一次签名调用不在关键路径上；附 catch 防止未处理拒绝。
        let signedUrlPromise: Promise<string> | undefined;
        if (storageKey) {
          signedUrlPromise = getStoredFileUrl(storageKey);
          void signedUrlPromise.catch(() => undefined);
        }

        if (extension === 'pdf' && fileSize <= 25 * 1024 * 1024) {
          try {
            const localPdfBuffer = await ensureFileBuffer();
            const localPdf = await measurePhase(
              'extract_local_pdf_text',
              () => extractLocalPdfText(localPdfBuffer),
              'read_and_parse_file'
            );
            if (localPdf.text.trim().length >= 30) {
              contentText = localPdf.text;
            }
          } catch (localPdfError) {
            console.warn('Local PDF text extraction failed:', localPdfError);
          }
        }

        if (contentText.trim().length < 30) {
          // 扫描 PDF、Office 文件和本地解析失败的 PDF 回退到 Coze 解析服务。
          const pendingSignedUrl = signedUrlPromise;
          const sourceUrl = pendingSignedUrl
            ? await measurePhase(
                'generate_signed_file_url',
                () => pendingSignedUrl,
                'read_and_parse_file'
              )
            : `data:${mimeType};base64,${(await ensureFileBuffer()).toString('base64')}`;
          const fetchConfig = new Config({ timeout: 120_000, retryTimes: 1 });
          const fetchClient = new FetchClient(fetchConfig, customHeaders);

          try {
            const fetchResponse = await measurePhase(
              'fetch_document_content',
              () => fetchClient.fetch(sourceUrl),
              'read_and_parse_file'
            );
            const textItems = fetchResponse.content.filter(
              item => item.type === 'text'
            );
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

              const scanned = await measurePhase(
                'ocr_scanned_pdf',
                () =>
                  extractScannedPdfText(
                    pageImageUrls,
                    fileName,
                    customHeaders
                  ),
                'read_and_parse_file'
              );
              modelCalls.push(...scanned.modelCalls);
              contentText = scanned.text || fileName;
            }
          } catch (fetchError) {
            console.error('FetchClient error:', fetchError);
            contentText = fileName;
          }
        }
      }

      contentPreview = contentText.slice(0, 500) + (contentText.length > 500 ? '...' : '');

        } catch (readError) {
          console.error('File read error:', readError);
          contentText = fileName;
        }
      });
    }

    // Shadow mode：先抽取结构化事实，但暂不改变当前分类和自动归档结论。
    let documentFacts: DocumentFacts | undefined;
    let persistedDocumentFactId: string | undefined;
    let factExtractionStep: ClassifyProcess['step0_factExtraction'];
    let minimalDecision: MinimalClassifyResult | undefined;
    let minimalPathStep: ClassifyProcess['step0_minimalPath'] | undefined;
    if (extractFacts) {
      const extraction = await measurePhase('extract_document_facts', () =>
        extractDocumentFacts({
          fileName,
          contentText,
          projectName: project?.name || '',
          customHeaders,
          imageDataUrl,
          cacheKey: factCacheKey,
        })
      );
      if (extraction.modelCall) modelCalls.push(extraction.modelCall);
      documentFacts = extraction.facts;
      factExtractionStep = {
        enabled: true,
        status: extraction.status,
        error: extraction.error,
        modelCall: extraction.modelCall,
        cacheHit: extraction.cacheHit,
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

    // 极简链路是唯一的分类建议来源。
    // 的状态，因此可以直接 A/B；将来极简版胜出时删掉 Agent 一整块即可。
    if (runMinimalPath && documentFacts && projectId) {
      const factsForMinimal = documentFacts;
      try {
        minimalDecision = await measurePhase('minimal_path', () =>
          classifyWithMinimalPath({
            projectId,
            projectName: project?.name,
            sourcePath: sourcePath || fileName,
            facts: factsForMinimal,
            fingerprint: `${fingerprint.kind}:${fingerprint.value}`,
            customHeaders,
          })
        );
        if (minimalDecision.modelCall) modelCalls.push(minimalDecision.modelCall);
        minimalPathStep = {
          enabled: true,
          status: minimalDecision.status,
          error: minimalDecision.error,
          modelCall: minimalDecision.modelCall,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        console.error('Minimal path error:', error);
        minimalPathStep = {
          enabled: true,
          status: 'fallback',
          error: message,
        };
      }
    }

    const targetFolder = minimalDecision?.folder ?? null;
    const process: ClassifyProcess = {
      step0_factExtraction: factExtractionStep,
      step0_minimalPath: minimalPathStep,
      finalDecision: targetFolder
        ? {
            method: 'minimal',
            explanation: `极简链路建议归入“${targetFolder.folderPath.slice(1).join(' / ')}”；请人工确认后归档`,
          }
        : {
            method: 'none',
            explanation: '极简链路未能唯一确定阶段，需要人工选择阶段文件夹',
          },
    };
    const result: ClassifyResult = {
      fileName,
      fileSize,
      targetFolder,
      reasoning: minimalDecision?.reasoning ?? minimalDecision?.error ?? '未能形成分类建议。',
      contentPreview,
      process,
      classificationMode: 'minimal',
      businessStage: minimalDecision?.stage,
      documentType: documentFacts?.documentType,
      suggestedArchiveTitle: fileName.replace(/\.[^.]+$/, ''),
      requiresArchiveConfirmation: true,
      minimalDecision,
    };
    if (documentFacts) result.documentFacts = documentFacts;

    // 自动归档
    if (
      autoArchive &&
      projectId &&
      result.targetFolder &&
      !result.requiresArchiveConfirmation
    ) {
      if (project) {
        const targetFolderForArchive = result.targetFolder;
        const extension = fileName.split('.').pop()?.toLowerCase() || '';
        const mimeType = suppliedMimeType || getMimeType(extension);
        const archived = await measurePhase('archive_file', async () =>
          storageKey
          ? archiveStoredFile({
              storageKey,
              originalName: fileName,
              fileSize,
              projectId,
              projectName: project.name,
              folderId: targetFolderForArchive.folderId,
              folderPath: targetFolderForArchive.folderPath,
              mimeType,
              // 把握程度已从链路中删除（那套档位是代码预设）。数据库列暂时保留，填 0。
              confidence: 0,
              reasoning: result.reasoning,
            })
          : archiveFile({
              fileBuffer:
                fileBuffer || Buffer.from(await file!.arrayBuffer()),
              originalName: fileName,
              projectId,
              projectName: project.name,
              folderId: targetFolderForArchive.folderId,
              folderPath: targetFolderForArchive.folderPath,
              mimeType,
              // 把握程度已从链路中删除（那套档位是代码预设）。数据库列暂时保留，填 0。
              confidence: 0,
              reasoning: result.reasoning,
            })
        );

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

    // 记录阶段文件夹决策，数据库旧列名仅由存储适配器内部兼容。
    if (persistFacts && project) {
      try {
        const decisionId = await createClassificationDecisionRecord({
          projectId: project.id,
          archivedFileId: result.archived?.id,
          documentFactId: persistedDocumentFactId,
          selectedFolderId: result.targetFolder?.folderId,
          selectedFolderName: result.targetFolder?.name,
          selectedFolderPath: result.targetFolder?.folderPath,
          candidateFolders: result.targetFolder
            ? [{
                folderId: result.targetFolder.folderId,
                folderPath: result.targetFolder.folderPath,
                score: 0,
              }]
            : [],
          evidence: documentFacts?.evidenceQuotes ?? [],
          contradictions: [],
          decisionScore: 0,
          decisionSource: 'none',
          reasoning: result.reasoning,
          policyVersion: 'minimal-v1',
          requiresReview:
            Boolean(result.requiresArchiveConfirmation) || !result.targetFolder,
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

    result.performance = {
      totalDurationMs: Date.now() - requestStartedAt,
      phases: phaseTimings,
      modelCalls,
    };

    // 慢在哪一步必须能一眼看到，否则调 OCR 精度、页数这些旋钮都是盲调。
    // 子阶段耗时包含在父阶段内，所以只打顶层，按耗时从大到小。
    console.log(
      `[classify] ${fileName} 合计 ${(
        result.performance.totalDurationMs / 1000
      ).toFixed(1)}s ｜ ` +
        phaseTimings
          .filter(item => !item.parentPhase)
          .sort((left, right) => right.durationMs - left.durationMs)
          .map(item => `${item.phase} ${(item.durationMs / 1000).toFixed(1)}s`)
          .join('  ')
    );
    result.contextRebuildPending = Boolean(documentFacts && result.archived);
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
