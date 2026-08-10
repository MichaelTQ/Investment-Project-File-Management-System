import { NextRequest, NextResponse } from 'next/server';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import type {
  ArchiveBusinessStage,
  ArchiveFolder,
} from '@/lib/folder-structure';
import { matchSpecTerm } from '@/lib/classification/naming-spec';
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
import {
  findMinimalDocument,
  loadMinimalArchive,
  upsertMinimalDocument,
} from '@/lib/classification/minimal/store';
import {
  getMimeType,
  isImageFile,
  readDocumentContent,
} from '@/lib/classification/read-document-content';
import {
  createClassificationDecisionRecord,
  createDocumentFingerprint,
  linkDocumentFactToArchivedFile,
  upsertDocumentFactsRecord,
} from '@/lib/project-memory';
import {
  archiveFile,
  archiveStoredFile,
  getArchivedFileSource,
  getProject,
  getStoredFileUrl,
  readStoredFile,
  uploadTempFileFromBuffer,
} from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * 这个接口有三种跑法。
 *
 * full   ——  单份文件的老流程：解析内容 → 抽事实 → 立刻判阶段，一次请求给出建议。
 * facts  ——  批量流程的第一阶段：解析内容 → 抽事实 → 只入库，**不判阶段**。
 * decide ——  批量流程的第二阶段：事实已在库里，只判阶段，跳过全部内容解析。
 *
 * 批量必须拆成两阶段，不能沿用 full 循环跑：判阶段时模型要看"同项目其他文件的事实"，
 * 一份份来的话，第一份文件判断时项目里空无一物，最后一份才看得到全貌——同一批文件
 * 得到的判断质量取决于它排在第几个。先把事实全抽完再统一判，每份文件看到的上下文
 * 才是一样的。
 */
type ClassifyMode = 'full' | 'facts' | 'decide';

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
  /** 归档判断的结论。 */
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
    let mode: ClassifyMode = 'full';
    let namingHint:
      | { term: string; stages: ArchiveBusinessStage[] }
      | undefined;
    // 对已归档文件补抽事实时带上归档记录 ID，写事实表时用它认领原有条目。
    let archivedFileIdForRecord = '';

    if (isJsonRequest) {
      const body = await request.json();
      mode =
        body.mode === 'facts' || body.mode === 'decide' ? body.mode : 'full';
      // 命名规范归一出来的词条，由前端在批量分流那一步拿到后透传回来。
      // 只有词条，阶段由服务端查表得出——前端不参与"哪个词条属于哪个阶段"的判断。
      if (typeof body.namingTerm === 'string') {
        const matched = matchSpecTerm(body.namingTerm);
        if (matched.term && matched.stages.length > 0) {
          namingHint = { term: matched.term, stages: matched.stages };
        }
      }
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

      // 对已归档文件补抽事实：文件早已不在 uploads/ 临时目录下，得按归档记录去取。
      // 这是"用户主动要求深挖某份文件"这条路，也是将来 agent 回补循环要用的同一个入口。
      const archivedFileId =
        typeof body.archivedFileId === 'string' ? body.archivedFileId : '';
      archivedFileIdForRecord = archivedFileId;
      if (archivedFileId) {
        const archivedSource = await measurePhase('load_archived_file', () =>
          getArchivedFileSource(archivedFileId)
        );
        if (!archivedSource || archivedSource.projectId !== projectId) {
          return NextResponse.json(
            { error: '未找到该归档文件' },
            { status: 404 }
          );
        }
        storageKey = archivedSource.storageKey;
        fileName = fileName || archivedSource.originalName;
        sourcePath = sourcePath || archivedSource.originalName;
        fileSize = fileSize || archivedSource.fileSize;
        suppliedMimeType = suppliedMimeType || archivedSource.mimeType;
      } else if (
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

    // 归档判断始终依赖结构化事实，并始终保留人工确认。
    autoArchive = false;
    const runMinimalPath = mode !== 'facts';
    // 三种模式都要抽事实，facts 模式尤其——它存在的意义就是抽事实。
    // 这里曾经写成 `extractFacts || persistFacts || runMinimalPath`，在只有 full
    // 一种模式时恒为 true 所以看不出问题；加上 facts 模式后 runMinimalPath 变成
    // false，两个环境变量默认也是 false，于是第一阶段静默跳过抽取、什么都没入库，
    // 第二阶段每份文件都拿 409。
    extractFacts = true;

    const project = projectId
      ? await measurePhase('load_project', () => getProject(projectId))
      : null;

    // 提取请求头
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);

    // 批量第二阶段：事实是第一阶段抽好入库的，这里只判阶段。
    // 必须在内容解析之前返回——重新解析一遍既白花时间，也可能因为临时文件已被
    // 清理而直接失败。
    if (mode === 'decide') {
      if (!projectId) {
        return NextResponse.json(
          { error: '判断阶段需要有效的 projectId' },
          { status: 400 }
        );
      }
      const documentPath = sourcePath || fileName;
      const archive = await measurePhase('load_minimal_archive', () =>
        loadMinimalArchive(projectId)
      );
      // 不能只按完整路径找：复核入口手里只有归档记录里的文件名，而事实是批量上传时
      // 按目录相对路径存的，精确比对会一律 409。
      const stored = findMinimalDocument(archive.documents, {
        sourcePath: documentPath,
        archivedFileId: archivedFileIdForRecord || undefined,
      });
      if (!stored) {
        return NextResponse.json(
          { error: `未找到《${fileName}》已抽取的事实，请重新上传该文件` },
          { status: 409 }
        );
      }

      let decision: MinimalClassifyResult | undefined;
      let decideError: string | undefined;
      try {
        decision = await measurePhase('minimal_path', () =>
          classifyWithMinimalPath({
            projectId,
            projectName: project?.name,
            sourcePath: documentPath,
            facts: stored.facts,
            fingerprint: stored.fingerprint,
            namingHint,
            projectNotes: project?.description,
            customHeaders,
          })
        );
        if (decision.modelCall) modelCalls.push(decision.modelCall);
      } catch (error) {
        decideError = error instanceof Error ? error.message : '未知错误';
        console.error('Minimal path error:', error);
      }

      const decidedFolder = decision?.folder ?? null;
      const decided: ClassifyResult = {
        fileName,
        fileSize,
        targetFolder: decidedFolder,
        reasoning:
          decision?.reasoning ?? decideError ?? '未能形成分类建议。',
        process: {
          step0_minimalPath: {
            enabled: true,
            status: decision?.status ?? 'fallback',
            error: decision?.error ?? decideError,
            modelCall: decision?.modelCall,
          },
          finalDecision: decidedFolder
            ? {
                method: 'minimal',
                explanation: `建议归入“${decidedFolder.folderPath
                  .slice(1)
                  .join(' / ')}”；请人工确认后归档`,
              }
            : {
                method: 'none',
                explanation: '未能唯一确定阶段，需要人工选择阶段文件夹',
              },
        },
        classificationMode: 'minimal',
        businessStage: decision?.stage,
        documentType: stored.facts.documentType,
        documentFacts: stored.facts,
        suggestedArchiveTitle: fileName.replace(/\.[^.]+$/, ''),
        requiresArchiveConfirmation: true,
        minimalDecision: decision,
        performance: {
          totalDurationMs: Date.now() - requestStartedAt,
          phases: phaseTimings,
          modelCalls,
        },
      };
      return NextResponse.json(decided);
    }

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
      // 读取链路已抽到 lib/classification/read-document-content.ts——深挖旁路要复用
      // 同一条链路，两边必须读到完全一样的东西。阶段耗时仍记在本请求上。
      const read = await readDocumentContent({
        fileName,
        fileSize,
        mimeType,
        extension,
        customHeaders,
        projectId: projectId || undefined,
        file: file ?? undefined,
        storageKey: storageKey || undefined,
        fileBuffer,
        measurePhase,
      });
      contentText = read.contentText;
      contentPreview = read.contentPreview;
      imageDataUrl = read.imageDataUrl;
      // 大文件会在读取过程中被转存到临时目录，storageKey 可能因此变化；
      // 缓冲区也可能是那边读进来的。两个都要接回来，后面归档还要用。
      fileBuffer = read.fileBuffer;
      if (read.storageKey) storageKey = read.storageKey;
      modelCalls.push(...read.modelCalls);
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

    // 批量第一阶段到此为止：事实入库，不判阶段。
    // 入库是必须的——第二阶段判每一份文件时都要读到同批其他文件的事实，事实不落盘
    // 就等于没抽。中断时这些条目要连同临时文件一起清掉，清理走 DELETE /api/uploads。
    if (mode === 'facts') {
      // 这一步没抽到事实就必须报错，不能返回 200。上一版在这里静默放过，结果是
      // 第一阶段"成功"跑完 35 份、第二阶段每份都 409，排查时看不出源头在哪。
      if (!projectId) {
        return NextResponse.json(
          { error: '抽取事实需要有效的 projectId' },
          { status: 400 }
        );
      }
      if (!documentFacts) {
        return NextResponse.json(
          {
            error: `未能抽取《${fileName}》的文档事实`,
            details: factExtractionStep?.error,
          },
          { status: 500 }
        );
      }
      // documentFacts 是 let，闭包里 TS 收不住它已经非空的窄化，绑一个常量给回调用。
      const factsToRecord = documentFacts;
      await measurePhase('record_document_facts', () =>
        upsertMinimalDocument({
          projectId,
          sourcePath: sourcePath || fileName,
          facts: factsToRecord,
          fingerprint: `${fingerprint.kind}:${fingerprint.value}`,
          // 复核入口只拿得到归档记录里的文件名，靠这个 ID 才能对上原来那条（带目录路径的）
          // 记录并原地覆盖，而不是新增一条。
          archivedFileId: archivedFileIdForRecord || undefined,
          factsExtracted: true,
        })
      );
      const factsOnly: ClassifyResult = {
        fileName,
        fileSize,
        targetFolder: null,
        reasoning: '事实已抽取，等待整批抽完后统一给出归档建议。',
        contentPreview,
        process: {
          step0_factExtraction: factExtractionStep,
          finalDecision: {
            method: 'none',
            explanation: '批量流程第一阶段：只抽事实，暂不判断阶段。',
          },
        },
        classificationMode: 'minimal',
        documentType: documentFacts?.documentType,
        suggestedArchiveTitle: fileName.replace(/\.[^.]+$/, ''),
        requiresArchiveConfirmation: false,
        performance: {
          totalDurationMs: Date.now() - requestStartedAt,
          phases: phaseTimings,
          modelCalls,
        },
      };
      if (documentFacts) factsOnly.documentFacts = documentFacts;
      console.log(
        `[classify:facts] ${fileName} 合计 ${(
          factsOnly.performance!.totalDurationMs / 1000
        ).toFixed(1)}s`
      );
      return NextResponse.json(factsOnly);
    }

    // 这是唯一的分类建议来源。
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
            // 单份上传也吃这条软提示。它不改变要做的事——内容照读、事实照抽——
            // 只是让模型和批量里的歧义分支看到同样的上下文。
            namingHint,
            projectNotes: project?.description,
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
            explanation: `建议归入“${targetFolder.folderPath.slice(1).join(' / ')}”；请人工确认后归档`,
          }
        : {
            method: 'none',
            explanation: '未能唯一确定阶段，需要人工选择阶段文件夹',
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

