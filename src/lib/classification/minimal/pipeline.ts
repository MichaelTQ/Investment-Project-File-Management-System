import {
  getFolderBusinessStage,
  getFolderForBusinessStage,
  type ArchiveBusinessStage,
  type ArchiveFolder,
} from '../../folder-structure';
import { listArchivedFiles } from '../../storage';
import {
  checkArchiveConsistency,
  type ArchiveDocument,
  type ConsistencyFinding,
} from '../archive-consistency';
import type { ModelCallDiagnostics } from '../chat-completions';
import type { DocumentFacts } from '../document-facts';
import {
  decideStageWithModel,
  type StageGuideMode,
} from '../llm-stage-decision';
import {
  buildTimeline,
  describeResolvedEvidence,
  resolveEvidence,
  type AnchorDiagnostic,
  type EvidenceStrength,
  type TimelineEntry,
} from './evidence';
import {
  loadMinimalArchive,
  upsertMinimalDocument,
  type MinimalDocument,
} from './store';

/**
 * 极简链路。与 Agent 链路完全隔离，只共用"读文件 / 抽事实"这类底层能力。
 *
 * 上传时：代码解析确定性证据 → 模型判一次 → 代码覆盖把握程度 → 存事实。
 * 重建时：代码拼时间线 + 全量一致性校验，零模型调用。
 */

export interface MinimalClassifyParams {
  projectId: string;
  projectName?: string;
  sourcePath: string;
  facts: DocumentFacts;
  fingerprint?: string;
  customHeaders?: Record<string, string>;
  /** 阶段说明用哪一版，用于验证文件类型清单是否在替模型答题。 */
  stageGuideMode?: StageGuideMode;
}

export interface MinimalClassifyResult {
  sourcePath: string;
  stage: ArchiveBusinessStage | null;
  folder: ArchiveFolder | null;
  /** 由证据强度推导，不采用模型自报的数值。 */
  confidence: number;
  strength: EvidenceStrength;
  /** 把握程度是怎么来的，一句话说清。 */
  confidenceBasis: string;
  reasoning: string;
  evidence: string[];
  contradictions: string[];
  requiresHumanReview: boolean;
  /** 判不出来时说清缺什么，而不是只说"证据不足"。 */
  missingEvidence?: string;
  /** 锚点没找到时的具体原因，界面据此提示用户下一步该补什么。 */
  anchorDiagnostic?: AnchorDiagnostic;
  relatedSourcePaths: string[];
  status: 'success' | 'fallback';
  error?: string;
  modelCall?: ModelCallDiagnostics;
  /** 本次实际使用的阶段说明版本，便于在界面上区分两次运行。 */
  stageGuideMode: StageGuideMode;
}

export async function classifyWithMinimalPath(
  params: MinimalClassifyParams
): Promise<MinimalClassifyResult> {
  const archive = await loadMinimalArchive(params.projectId);
  const others = archive.documents.filter(
    document => document.sourcePath !== params.sourcePath
  );

  const current: MinimalDocument = {
    sourcePath: params.sourcePath,
    facts: params.facts,
    stage: null,
    fingerprint: params.fingerprint,
    updatedAt: Date.now(),
  };
  const resolved = resolveEvidence(current, others);

  const decision = await decideStageWithModel({
    sourcePath: params.sourcePath,
    facts: params.facts,
    projectName: params.projectName,
    relatedDocuments: others.map(document => ({
      sourcePath: document.sourcePath,
      facts: document.facts,
    })),
    resolvedEvidence: describeResolvedEvidence(resolved),
    stageGuideMode: params.stageGuideMode ?? 'examples',
    customHeaders: params.customHeaders,
  });

  const stage =
    (decision.decision?.businessStage as ArchiveBusinessStage | null) ?? null;
  const folder = stage ? getFolderForBusinessStage(stage) : null;

  // 事实先存下来：即便本次没判出阶段，它也是后续文件比对的原料。
  await upsertMinimalDocument({
    projectId: params.projectId,
    sourcePath: params.sourcePath,
    facts: params.facts,
    fingerprint: params.fingerprint,
  });

  // 缺什么直接用代码算出的诊断，不再套那句写死的"缺少股东会决议"——
  // 实际缺的可能是本文件自己的数值，也可能是数值对不上号，处置方式完全不同。
  const missingEvidence =
    !stage && resolved.anchorDiagnostic
      ? resolved.anchorDiagnostic.detail
      : undefined;

  // 数值对不上号说明两份文件之间还有没归档的变更，或者数字读错了。
  // 这是必须有人看的信号，不能让模型用高把握直接放行。
  const anchorConflict =
    resolved.anchorDiagnostic?.reason === 'value_mismatch';

  return {
    sourcePath: params.sourcePath,
    stage,
    folder,
    confidence: resolved.confidence,
    strength: resolved.strength,
    confidenceBasis: resolved.basis,
    reasoning: decision.decision?.reasoning ?? decision.error ?? '模型未返回结论。',
    evidence: decision.decision?.evidence ?? [],
    contradictions: decision.decision?.contradictions ?? [],
    requiresHumanReview:
      anchorConflict || (decision.decision?.requiresHumanReview ?? true),
    missingEvidence,
    anchorDiagnostic: resolved.anchorDiagnostic ?? undefined,
    relatedSourcePaths: resolved.transactionSide
      ? [resolved.transactionSide.anchorSourcePath]
      : resolved.sameTypeSiblings,
    status: decision.status,
    error: decision.error,
    modelCall: decision.modelCall,
    stageGuideMode: params.stageGuideMode ?? 'examples',
  };
}

export interface MinimalRebuildReport {
  documentCount: number;
  checkedCount: number;
  skippedCount: number;
  timeline: TimelineEntry[];
  findings: ConsistencyFinding[];
  dismissedCount: number;
}

/**
 * 每次归档之后全量重跑：拼时间线 + 校验一致性。
 *
 * 全部是纯计算，所以不需要挑时机、不需要增量。晚到的交易文件正是靠这一步回头
 * 纠正先前判错的文件。
 */
export async function rebuildMinimalArchive(
  projectId: string
): Promise<MinimalRebuildReport> {
  const [archive, archivedFiles] = await Promise.all([
    loadMinimalArchive(projectId),
    listArchivedFiles(projectId),
  ]);

  const archivedById = new Map(archivedFiles.map(file => [file.id, file]));
  const archivedByName = new Map(
    archivedFiles.map(file => [file.originalName, file])
  );

  const documents: ArchiveDocument[] = [];
  const withStage: MinimalDocument[] = [];
  let skippedCount = 0;

  for (const document of archive.documents) {
    const leafName =
      document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
    // 基准是文件实际归在哪，不是本链路当初建议归哪——用户手动改过要以用户为准。
    const archived =
      (document.archivedFileId
        ? archivedById.get(document.archivedFileId)
        : undefined) ?? archivedByName.get(leafName);
    const stage = archived ? getFolderBusinessStage(archived.folderId) : null;

    withStage.push({ ...document, stage });
    if (!stage) {
      skippedCount += 1;
      continue;
    }
    documents.push({
      sourcePath: document.sourcePath,
      facts: document.facts,
      currentStage: stage,
      fingerprint: document.fingerprint,
    });
  }

  const dismissed = new Set(archive.dismissedFindings);
  const allFindings = checkArchiveConsistency(documents);
  const findings = allFindings.filter(
    finding => !dismissed.has(`${finding.kind}:${finding.sourcePath}`)
  );

  return {
    documentCount: archive.documents.length,
    checkedCount: documents.length,
    skippedCount,
    timeline: buildTimeline(withStage),
    findings,
    dismissedCount: allFindings.length - findings.length,
  };
}
