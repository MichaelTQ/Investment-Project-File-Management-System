import {
  getFolderBusinessStage,
  type ArchiveBusinessStage,
  type ArchiveFolder,
} from '../../folder-structure';
import { listArchivedFiles } from '../../storage';
import type { ModelCallDiagnostics } from '../chat-completions';
import type { DocumentFacts } from '../document-facts';
import {
  decideStageWithModel,
  STAGE_DEFINITIONS,
} from '../llm-stage-decision';
import {
  reviewConflictsWithModel,
  type ConflictFinding,
} from './conflict-review';
import { buildTimeline, describeTimeline, type TimelineEntry } from './evidence';
import {
  checkValueTimepointConflicts,
  suggestDocumentsToDeepen,
  type DeepenSuggestion,
} from './rule-checks';
import {
  loadMinimalArchive,
  upsertMinimalDocument,
  type MinimalDocument,
} from './store';

/**
 * 极简链路。
 *
 * 上传时：模型机械抽取客观事实 → 代码把同项目其他文件的事实和时间线摆出来 →
 * 模型判断阶段。代码不产生任何业务结论。
 *
 * 重建时：代码按日期排出时间线 → 模型比对全项目、指出矛盾。
 *
 * 设计原则：**代码只搬运事实，不夹带业务知识。** 曾经写在这里的交易锚点、
 * 增资倾向、证据强度档位、文件类型与阶段的对应关系已全部删除——它们让准确率
 * 看起来更高，代价是系统只在预设覆盖的情况里有效，且用户看到的"判断"其实是
 * 代码的预设在说话。
 */

export interface MinimalClassifyParams {
  projectId: string;
  projectName?: string;
  sourcePath: string;
  facts: DocumentFacts;
  fingerprint?: string;
  /** 命名规范给出的候选阶段，软提示。见 LlmStageDecisionParams.namingHint。 */
  namingHint?: { term: string; stages: ArchiveBusinessStage[] };
  /** 项目负责人填写的归档口径。 */
  projectNotes?: string;
  customHeaders?: Record<string, string>;
}

export interface MinimalClassifyResult {
  sourcePath: string;
  stage: ArchiveBusinessStage | null;
  folder: ArchiveFolder | null;
  reasoning: string;
  evidence: string[];
  contradictions: string[];
  requiresHumanReview: boolean;
  status: 'success' | 'fallback';
  error?: string;
  modelCall?: ModelCallDiagnostics;
}

export async function classifyWithMinimalPath(
  params: MinimalClassifyParams
): Promise<MinimalClassifyResult> {
  const archive = await loadMinimalArchive(params.projectId);
  const others = archive.documents.filter(
    document => document.sourcePath !== params.sourcePath
  );

  const decision = await decideStageWithModel({
    sourcePath: params.sourcePath,
    facts: params.facts,
    projectName: params.projectName,
    relatedDocuments: others.map(document => ({
      sourcePath: document.sourcePath,
      facts: document.facts,
    })),
    // 带上各文件的归档位置：归档必须人工确认，所以这是人工确认过的事实，
    // 是这套系统里最硬的信号。提示词里同时约束它不能成为唯一依据。
    timeline: describeTimeline(buildTimeline(others), { showStage: true }),
    namingHint: params.namingHint,
    projectNotes: params.projectNotes,
    customHeaders: params.customHeaders,
  });

  const stage = decision.decision?.businessStage ?? null;

  // 事实先存下来：即便本次没判出阶段，它也是后续文件比对的原料。
  await upsertMinimalDocument({
    projectId: params.projectId,
    sourcePath: params.sourcePath,
    facts: params.facts,
    fingerprint: params.fingerprint,
  });

  return {
    sourcePath: params.sourcePath,
    stage,
    folder: decision.decision?.selectedFolder ?? null,
    reasoning: decision.decision?.reasoning ?? decision.error ?? '模型未返回结论。',
    evidence: decision.decision?.evidence ?? [],
    contradictions: decision.decision?.contradictions ?? [],
    requiresHumanReview: decision.decision?.requiresHumanReview ?? true,
    status: decision.status,
    error: decision.error,
    modelCall: decision.modelCall,
  };
}

/** 一份已存文件的事实，原样交给界面展示。 */
export interface MinimalArchivedDocument {
  sourcePath: string;
  stage: ArchiveBusinessStage | null;
  facts: DocumentFacts;
  updatedAt: number;
}

export interface MinimalRebuildReport {
  documentCount: number;
  checkedCount: number;
  skippedCount: number;
  /** 每份文件抽取出来的事实。界面据此展示"这份文件系统读到了什么"。 */
  documents: MinimalArchivedDocument[];
  timeline: TimelineEntry[];
  findings: ConflictFinding[];
  dismissedCount: number;
  /** 确定性检查的结果。不调模型，常开。 */
  ruleFindings: ConflictFinding[];
  /** 建议人工深挖的文件。系统只标记，不自动执行。 */
  deepenSuggestions: DeepenSuggestion[];
  /** 冲突复核失败时的说明。为空表示复核正常完成。 */
  reviewError?: string;
  modelCall?: ModelCallDiagnostics;
}

/**
 * 每次归档之后全量重跑：排时间线 + 交模型比对冲突。
 *
 * 必须全量重跑而不是增量：决定性的文件经常比它要推翻的那份晚到。先传的章程当时
 * 判不准是正常的，直到决议进来，才谈得上发现矛盾。
 */
export async function rebuildMinimalArchive(
  projectId: string,
  options: {
    projectName?: string;
    projectNotes?: string;
    customHeaders?: Record<string, string>;
    /**
     * 是否跑**模型**冲突复核。默认跑。
     *
     * 只是想看已存事实和时间线时必须关掉——复核要调模型，切换项目、刷新页面
     * 都触发的话，成本和等待时间都白花。时间线和事实本来就是纯读取。
     *
     * 确定性检查不受这个开关影响，它不调模型也不会误报，任何时候都跑。
     */
    reviewConflicts?: boolean;
  } = {}
): Promise<MinimalRebuildReport> {
  const [archive, archivedFiles] = await Promise.all([
    loadMinimalArchive(projectId),
    listArchivedFiles(projectId),
  ]);

  const archivedById = new Map(archivedFiles.map(file => [file.id, file]));
  const archivedByName = new Map(
    archivedFiles.map(file => [file.originalName, file])
  );

  const withStage: MinimalDocument[] = [];
  const archivedDocuments: MinimalDocument[] = [];
  let skippedCount = 0;

  for (const document of archive.documents) {
    const leaf = document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
    // 基准是文件实际归在哪，不是本链路当初建议归哪——用户手动改过要以用户为准。
    const archived =
      (document.archivedFileId
        ? archivedById.get(document.archivedFileId)
        : undefined) ?? archivedByName.get(leaf);
    const stage = archived ? getFolderBusinessStage(archived.folderId) : null;

    // 阶段以文件实际所在目录为准，但"是谁定的"要沿用档案里记的。
    // 归档后被人手动移动过的，来源应当升级为人工。
    const movedByHuman = Boolean(
      stage && document.stage && stage !== document.stage
    );
    const withCurrentStage: MinimalDocument = {
      ...document,
      stage,
      stageSource: movedByHuman ? 'human' : document.stageSource,
    };
    withStage.push(withCurrentStage);
    if (stage) {
      archivedDocuments.push(withCurrentStage);
    } else {
      skippedCount += 1;
    }
  }

  const timeline = buildTimeline(withStage);
  const documents: MinimalArchivedDocument[] = withStage.map(document => ({
    sourcePath: document.sourcePath,
    stage: document.stage,
    facts: document.facts,
    updatedAt: document.updatedAt,
  }));

  const review =
    options.reviewConflicts === false
      ? { findings: [], error: undefined, modelCall: undefined }
      : await reviewConflictsWithModel({
          documents: archivedDocuments,
          timeline,
          projectName: options.projectName,
          projectNotes: options.projectNotes,
          stageDefinitions: STAGE_DEFINITIONS,
          // 事后过滤保留在下面当兜底，但先让模型知道用户忽略过什么：否则同一条
          // 误报每次都要重新生成一遍再被丢掉，白花钱，还会因为换了措辞绕过过滤。
          dismissedFindings: archive.dismissedFindings,
          customHeaders: options.customHeaders,
        });

  const dismissed = new Set(archive.dismissedFindings);
  const findings = review.findings.filter(
    finding => !dismissed.has(conflictKey(finding))
  );

  // 确定性检查不受 reviewConflicts 开关影响：不调模型、不会误报，没有关掉的理由。
  const ruleFindings = checkValueTimepointConflicts(archivedDocuments).filter(
    finding => !dismissed.has(conflictKey(finding))
  );

  return {
    documentCount: archive.documents.length,
    checkedCount: archivedDocuments.length,
    skippedCount,
    documents,
    timeline,
    findings,
    ruleFindings,
    deepenSuggestions: suggestDocumentsToDeepen(withStage),
    dismissedCount: review.findings.length - findings.length,
    reviewError: review.error,
    modelCall: review.modelCall,
  };
}

/**
 * 冲突的稳定标识，用于记住"用户已忽略过这条"。
 *
 * 模型每次措辞可能略有不同，所以用涉及的文件加描述一起做键；描述变了会被当成
 * 新的一条重新提示——宁可多问一次，也不要把新问题当成旧的忽略掉。
 */
export function conflictKey(finding: ConflictFinding): string {
  return `${[...finding.sourcePaths].sort().join('|')}::${finding.description}`;
}
