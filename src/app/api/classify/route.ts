import { NextRequest, NextResponse } from 'next/server';
import {
  LLMClient,
  FetchClient,
  Config,
  HeaderUtils,
  type ContentPart,
} from 'coze-coding-dev-sdk';
import {
  getFolderForBusinessStage,
  type ArchiveFolder,
} from '@/lib/folder-structure';
import {
  DOCUMENT_FACTS_EXTRACTOR_VERSION,
  DOCUMENT_FACTS_MODEL,
  extractDocumentFacts,
} from '@/lib/classification/fact-extractor';
import type { DocumentFacts } from '@/lib/classification/document-facts';
import {
  inferBusinessStage,
  type BusinessStageDecision,
} from '@/lib/classification/business-stage';
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
  commitArchivedProjectDocument,
  evaluateProjectDocumentCandidate,
  type ProjectSessionMemoryView,
} from '@/lib/classification/session-project-memory';
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

// 分类过程详情
interface ClassifyProcess {
  step0_businessStage?: BusinessStageDecision;
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
  step0_projectSessionMemory?: {
    enabled: boolean;
    status: 'success' | 'skipped' | 'failed';
    mode?: ProjectSessionMemoryView['mode'];
    persistent?: boolean;
    persistenceWarning?: string;
    documentCount?: number;
    relatedDocumentCount?: number;
    reEvaluatedCount?: number;
    revision?: number;
    contextStatus?: NonNullable<
      ProjectSessionMemoryView['contextSynthesis']
    >['status'];
    contextLlmCallCount?: number;
    contextEventCount?: number;
    contextRelationCount?: number;
    latestEvidencedStage?: NonNullable<
      ProjectSessionMemoryView['contextSynthesis']
    >['latestEvidencedStage'];
    error?: string;
  };
  decisionPersistence?: {
    status: 'success' | 'failed';
    recordId?: string;
    error?: string;
  };
  finalDecision: {
    method: 'agent' | 'stage' | 'none';
    explanation: string;
  };
}

// 文件分类结果接口
interface ClassifyResult {
  fileName: string;
  fileSize: number;
  targetFolder: ArchiveFolder | null;
  confidence: number;
  reasoning: string;
  contentPreview?: string;
  process: ClassifyProcess;
  classificationMode: 'agent' | 'comparison';
  businessStage?: string | null;
  documentType?: string;
  suggestedArchiveTitle?: string;
  documentFacts?: DocumentFacts;
  contextDecision?: ContextClassificationDecision;
  agentDecision?: ClassificationAgentResult;
  projectSessionMemory?: ProjectSessionMemoryView;
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
4. 注册资本总额、股东名称、认缴金额、持股比例，以及“由/增加至/变更为”等交易前后变化
5. 能帮助识别文件客观类型和交易事实的章节标题与核心事项

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
    let runLegacyDecision = true;
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
      runLegacyDecision = body.legacyDecision !== false;
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
      runLegacyDecision = formData.get('legacyDecision') !== 'false';
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

    // Agent 主模式必须运行 Agent，并始终由用户确认后再归档。
    if (!runLegacyDecision) {
      runAgentDecision = true;
      autoArchive = false;
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
    let projectSessionMemory: ProjectSessionMemoryView | undefined;
    let projectSessionMemoryStep:
      | ClassifyProcess['step0_projectSessionMemory']
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
        if (project) {
          try {
            const memoryEvaluation =
              await evaluateProjectDocumentCandidate({
                projectId: project.id,
                projectName: project.name,
                sourcePath: sourcePath || fileName,
                facts: documentFacts,
                projectContext,
                suppliedRelatedDocuments: relatedDocumentFacts,
                customHeaders,
              });
            const { currentDecision, ...memoryView } = memoryEvaluation;
            agentClassificationResult = currentDecision;
            projectSessionMemory = memoryView;
            projectSessionMemoryStep = {
              enabled: true,
              status: 'success',
              mode: memoryView.mode,
              persistent: memoryView.persistent,
              persistenceWarning: memoryView.persistenceWarning,
              documentCount: memoryView.documentCount,
              relatedDocumentCount: memoryView.relatedDocumentCount,
              reEvaluatedCount: memoryView.reEvaluatedDocuments.length,
              revision: memoryView.revision,
              contextStatus: memoryView.contextSynthesis?.status,
              contextLlmCallCount: memoryView.contextSynthesis?.llmCallCount,
              contextEventCount: memoryView.contextSynthesis?.eventCount,
              contextRelationCount: memoryView.contextSynthesis?.relationCount,
              latestEvidencedStage:
                memoryView.contextSynthesis?.latestEvidencedStage,
            };
          } catch (memoryError) {
            const message =
              memoryError instanceof Error
                ? memoryError.message
                : '未知错误';
            console.error('Project session memory error:', memoryError);
            projectSessionMemoryStep = {
              enabled: true,
              status: 'failed',
              error: message,
            };
          }
        } else {
          projectSessionMemoryStep = {
            enabled: true,
            status: 'skipped',
            error: '会话项目记忆需要有效的 projectId',
          };
        }
        agentClassificationResult ??= await runClassificationAgent({
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

    // 最终只判断业务阶段；阶段文件夹本身就是归档目标。
    const legacyStageDecision = inferBusinessStage({
      sourcePath: sourcePath || fileName,
      text: contentText,
      facts: documentFacts,
      projectContext,
      relatedDocuments: relatedDocumentFacts,
    });

    const process: ClassifyProcess = {
      step0_businessStage: legacyStageDecision,
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
      step0_projectSessionMemory: projectSessionMemoryStep,
      finalDecision: { method: 'none', explanation: '' },
    };

    const agentDecision = agentClassificationResult?.decision;
    const targetFolder = !runLegacyDecision
      ? agentDecision?.selectedFolder ?? null
      : legacyStageDecision.selectedStage
        ? getFolderForBusinessStage(legacyStageDecision.selectedStage)
        : null;

    if (targetFolder) {
      process.finalDecision = {
        method: !runLegacyDecision ? 'agent' : 'stage',
        explanation: !runLegacyDecision
          ? `Agent 建议归入“${targetFolder.folderPath.slice(1).join(' / ')}”；正式归档前由用户确认`
          : `业务阶段已确定，直接归入“${targetFolder.folderPath.slice(1).join(' / ')}”`,
      };
    } else {
      process.finalDecision = {
        method: 'none',
        explanation: '业务阶段无法唯一确定，需要人工选择阶段文件夹',
      };
    }

    const result: ClassifyResult = {
      fileName,
      fileSize,
      targetFolder,
      confidence: !runLegacyDecision
        ? agentDecision?.confidence ?? 0
        : legacyStageDecision.confidence,
      reasoning: !runLegacyDecision
        ? agentDecision?.reasoning ?? 'Agent 未能确定业务阶段。'
        : legacyStageDecision.reasoning,
      contentPreview,
      process,
      classificationMode: !runLegacyDecision ? 'agent' : 'comparison',
      suggestedArchiveTitle: fileName.replace(/\.[^.]+$/, ''),
      requiresArchiveConfirmation: !runLegacyDecision || !targetFolder,
    };
    if (documentFacts) result.documentFacts = documentFacts;
    result.documentType = documentFacts?.documentType;
    result.businessStage =
      agentClassificationResult?.decision.businessStage ??
      contextClassificationDecision?.businessStage ??
      legacyStageDecision.selectedStage;
    if (contextClassificationDecision) {
      result.contextDecision = contextClassificationDecision;
    }
    if (agentClassificationResult) {
      result.agentDecision = agentClassificationResult;
    }
    if (projectSessionMemory) {
      result.projectSessionMemory = projectSessionMemory;
    }

    // 自动归档
    if (
      autoArchive &&
      projectId &&
      result.targetFolder &&
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
              folderId: result.targetFolder.folderId,
              folderPath: result.targetFolder.folderPath,
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
              folderId: result.targetFolder.folderId,
              folderPath: result.targetFolder.folderPath,
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

        if (documentFacts) {
          try {
            const committed = await commitArchivedProjectDocument({
              projectId: project.id,
              projectName: project.name,
              sourcePath: sourcePath || fileName,
              facts: documentFacts,
              archivedFileId: archived.id,
              customHeaders,
            });
            const { currentDecision: _committedDecision, ...committedView } =
              committed;
            void _committedDecision;
            committedView.decisionContextVersion =
              projectSessionMemory?.decisionContextVersion;
            projectSessionMemory = committedView;
            result.projectSessionMemory = committedView;
            projectSessionMemoryStep = {
              enabled: true,
              status: 'success',
              mode: committedView.mode,
              persistent: committedView.persistent,
              persistenceWarning: committedView.persistenceWarning,
              documentCount: committedView.documentCount,
              relatedDocumentCount: committedView.relatedDocumentCount,
              reEvaluatedCount: committedView.reEvaluatedDocuments.length,
              revision: committedView.revision,
              contextStatus: committedView.contextSynthesis?.status,
              contextLlmCallCount:
                committedView.contextSynthesis?.llmCallCount,
              contextEventCount: committedView.contextSynthesis?.eventCount,
              contextRelationCount:
                committedView.contextSynthesis?.relationCount,
              latestEvidencedStage:
                committedView.contextSynthesis?.latestEvidencedStage,
            };
          } catch (contextCommitError) {
            console.error(
              'Archived document Context commit failed:',
              contextCommitError
            );
            projectSessionMemoryStep = {
              enabled: true,
              status: 'failed',
              error:
                contextCommitError instanceof Error
                  ? contextCommitError.message
                  : '归档成功，但项目Context提交失败',
            };
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
                score: result.confidence,
              }]
            : [],
          evidence: documentFacts?.evidenceQuotes ?? [],
          contradictions: [],
          decisionScore: result.confidence,
          decisionSource:
            process.finalDecision.method === 'agent'
              ? 'context'
              : process.finalDecision.method === 'stage'
                ? 'context'
                : 'none',
          reasoning: result.reasoning,
          policyVersion:
            process.finalDecision.method === 'agent'
              ? agentClassificationResult?.graphVersion ?? 'classification-agent'
              : 'stage-folder-classification-v5',
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
