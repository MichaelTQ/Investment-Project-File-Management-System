'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  Folder, FolderOpen, FileText, Upload, CheckCircle2, AlertCircle,
  ChevronRight, ChevronDown, Loader2, Brain, Zap,
  Plus, Trash2, Download, Archive, Building2, Clock, X,
  History, ArrowRightLeft, MoreHorizontal, Pencil, Eye, Sparkles
} from 'lucide-react';
import {
  FOLDER_STRUCTURE,
  SYSTEM_ARCHIVE_FOLDERS,
  type FolderNode,
  type ArchiveFolder,
  type Project,
  type ArchivedFile,
  getFolderForBusinessStage,
} from '@/lib/folder-structure';
import { inferBusinessStage } from '@/lib/classification/business-stage';

interface ClassifyProcess {
  finalDecision: {
    method: 'agent' | 'stage' | 'none';
    explanation: string;
  };
}

interface AgentTraceStep {
  node:
    | 'plan_evidence'
    | 'retrieve_related_document'
    | 'context_decision'
    | 'complete'
    | 'human_review';
  tool?: string;
  summary: string;
  round: number;
}

interface AgentDecisionResult {
  status: 'decided' | 'needs_review';
  decision: {
    status: 'decided' | 'insufficient' | 'conflict';
    selectedFolder: ArchiveFolder | null;
    businessStage: string | null;
    stageConfidence: number;
    routingMethod:
      | 'context_policy'
      | 'stage_policy'
      | 'needs_stage_review';
    confidence: number;
    evidence: string[];
    contradictions: string[];
    requiresHumanReview: boolean;
    reasoning: string;
    policyVersion: string;
  };
  selectedRelatedDocuments: Array<{ sourcePath: string }>;
  requestedEvidence: string[];
  trace: AgentTraceStep[];
  rounds: number;
  llmCallCount: number;
  graphVersion: string;
}

interface ModelCallDiagnostics {
  model: string;
  inputCharacters: number;
  estimatedInputTokens: number;
  outputCharacters: number;
  outputTokens: number | null;
  finishReason: string | null;
  maxOutputTokens: number;
  responseHeadersDurationMs?: number;
  durationMs: number;
}

interface ProcessingPerformance {
  totalDurationMs: number;
  phases: Array<{
    phase: string;
    durationMs: number;
    parentPhase?: string;
  }>;
  modelCalls: ModelCallDiagnostics[];
}

interface RebuildHistoryEntry {
  trigger: 'add_file' | 'delete_file' | 'manual';
  timestamp: number;
  totalDurationMs: number;
  synthesisDurationMs: number;
  reevaluationDurationMs: number;
  llmCallCount: number;
  inputTokens: number;
  outputTokens: number;
  inputDocumentCount: number;
  includedDocumentCount: number;
  reevaluationMode: 'incremental' | 'full';
  totalDocumentCount: number;
  reEvaluatedDocumentCount: number;
  changedDecisionCount: number;
  status: 'success' | 'failed';
  contextVersion: number;
  contextStatus: 'llm_synthesized' | 'deterministic_fallback';
  stageTransition?: { from: string; to: string };
  error?: string;
}

interface ProjectSessionMemoryResult {
  mode: 's3-durable-shadow' | 'process-local-fallback';
  persistent: boolean;
  persistenceWarning?: string;
  memoryLoadDurationMs: number;
  projectId: string;
  revision: number;
  documentCount: number;
  relatedDocumentCount: number;
  documents: Array<{
    sourcePath: string;
    documentType: string;
    title: string;
    sourceQuality: string;
    extractionConfidence: number;
    factStatus: 'extracted' | 'repaired' | 'fallback' | 'type_recovered';
    warnings: string[];
    agentStatus: 'decided' | 'needs_review' | null;
    selectedFolder: string | null;
  }>;
  projectContext?: {
    contextStatus: string;
    latestEvidencedStage: string;
    stageConfidence: 'low' | 'medium' | 'high';
    timeline: Array<{
      date: string | null;
      eventType: string;
      stage: string;
      title: string;
      evidenceFiles: string[];
      evidence: string;
      confidence: 'low' | 'medium' | 'high';
    }>;
    openQuestions: string[];
    synthesisWarnings?: string[];
  } | null;
  contextState: {
    status: 'clean' | 'dirty' | 'rebuilding' | 'failed';
    version: number;
    basedOnRevision: number;
    dirtyReasons: string[];
    updatedAt: number | null;
    lastAttemptAt: number | null;
    lastError?: string;
  };
  decisionContextVersion?: number;
  contextSynthesis?: {
    status: 'llm_synthesized' | 'deterministic_fallback';
    llmCallCount: number;
    modelCalls: ModelCallDiagnostics[];
    totalDurationMs: number;
    inputDocumentCount: number;
    includedDocumentCount: number;
    latestEvidencedStage: string;
    stageConfidence: 'low' | 'medium' | 'high';
    eventCount: number;
    relationCount: number;
    conflictCount: number;
    error?: string;
  };
  reEvaluatedDocuments: Array<{
    sourcePath: string;
    previousStatus: 'decided' | 'needs_review';
    status: 'decided' | 'needs_review';
    previousFolder: string | null;
    selectedFolder: string | null;
    agentDecision: AgentDecisionResult;
  }>;
  rebuildHistory?: RebuildHistoryEntry[];
  expiresAt?: string;
}

interface ConsistencyFinding {
  kind:
    | 'transaction_side_conflict'
    | 'version_order_conflict'
    | 'duplicate_stage_mismatch'
    | 'missing_companion_document';
  sourcePath: string;
  currentStage: string | null;
  constraint: string;
  reason: string;
  evidence: string[];
  relatedSourcePaths: string[];
}

interface ConsistencyReport {
  checkedCount: number;
  skippedCount: number;
  findings: ConsistencyFinding[];
}

interface ModelStageDecisionResult {
  status: 'success' | 'fallback';
  decision: AgentDecisionResult['decision'] | null;
  error?: string;
}

interface ClassifyResult {
  clientId: string;
  fileName: string;
  sourcePath?: string;
  fileSize: number;
  targetFolder: ArchiveFolder | null;
  confidence: number;
  reasoning: string;
  contentPreview?: string;
  process: ClassifyProcess;
  classificationMode: 'agent' | 'comparison';
  businessStage?: string | null;
  documentType?: string;
  legacyClassification?: {
    targetFolder: ArchiveFolder | null;
    confidence: number;
    reasoning: string;
  };
  agentDecision?: AgentDecisionResult;
  modelStageDecision?: ModelStageDecisionResult;
  modelStagePending?: boolean;
  projectSessionMemory?: ProjectSessionMemoryResult;
  documentFacts?: unknown;
  suggestedArchiveTitle?: string;
  requiresArchiveConfirmation?: boolean;
  sourceFile?: File;
  sourceStorageKey?: string;
  sourceMimeType?: string;
  sourceProjectId?: string;
  archiveStatus?: 'pending' | 'archiving' | 'archived' | 'cancelled' | 'error';
  archiveError?: string;
  archived?: { id: string; archivedName: string; projectName: string; folderPath: string[]; };
  performance?: ProcessingPerformance;
  agentPending?: boolean;
  rulePreliminary?: boolean;
  contextRebuildPending?: boolean;
}

const AGENT_NODE_LABELS: Record<AgentTraceStep['node'], string> = {
  plan_evidence: '规划证据',
  retrieve_related_document: '检索关联文件',
  context_decision: '上下文决策',
  complete: '形成建议',
  human_review: '转人工复核',
};

const PROJECT_STAGE_LABELS: Record<string, string> = {
  pre_initiation: '立项前',
  initiation: '项目立项',
  due_diligence: '尽职调查',
  investment_decision: '投资决策',
  investment_execution: '投资实施',
  post_investment: '投后管理',
  exit_decision: '退出决策',
  exit_execution: '退出执行',
  unknown: '尚未确定',
};

function AgentDecisionPanel({
  agent,
  projectMemory,
  performance,
}: {
  agent: AgentDecisionResult;
  projectMemory?: ProjectSessionMemoryResult;
  performance?: ProcessingPerformance;
}) {
  const suggestion = agent.decision.selectedFolder;
  const needsReview = agent.status === 'needs_review';

  return (
    <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-violet-700" />
          <h4 className="text-sm font-medium text-violet-950">Agent 上下文建议</h4>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="border-violet-300 bg-white text-violet-700">
            Shadow
          </Badge>
          {projectMemory && (
            <Badge variant="outline" className="border-violet-300 bg-white text-violet-700">
              项目记忆 {projectMemory.documentCount} 份
            </Badge>
          )}
          <Badge
            variant="outline"
            className={needsReview
              ? 'border-amber-300 bg-amber-50 text-amber-700'
              : 'border-green-300 bg-green-50 text-green-700'}
          >
            {needsReview ? '需要人工复核' : '证据充分'}
          </Badge>
        </div>
      </div>

      <div className="rounded-md border bg-white p-3 text-sm">
        <p className="text-xs text-muted-foreground">建议归档位置</p>
        <p className="mt-1 break-words font-medium text-violet-900">
          {suggestion
            ? suggestion.folderPath.join(' / ')
            : '暂不建议分类，等待人工处理'}
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {agent.decision.reasoning}
        </p>
      </div>

      {agent.decision.evidence.length > 0 && (
        <div>
          <p className="text-xs font-medium text-green-800">支持证据</p>
          <ul className="mt-1 space-y-1 text-xs leading-5 text-green-800">
            {agent.decision.evidence.map((item, index) => (
              <li key={`${item}-${index}`} className="flex gap-2">
                <span aria-hidden="true">✓</span>
                <span className="break-words">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {agent.decision.contradictions.length > 0 && (
        <div>
          <p className="text-xs font-medium text-amber-800">冲突或风险</p>
          <ul className="mt-1 space-y-1 text-xs leading-5 text-amber-800">
            {agent.decision.contradictions.map((item, index) => (
              <li key={`${item}-${index}`} className="flex gap-2">
                <span aria-hidden="true">!</span>
                <span className="break-words">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {agent.selectedRelatedDocuments.length > 0 && (
        <div>
          <p className="text-xs font-medium text-violet-900">使用的关联文件</p>
          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
            {agent.selectedRelatedDocuments.map(item => item.sourcePath).join('；')}
          </p>
        </div>
      )}

      {projectMemory && (
        <div className="rounded-md border border-violet-200 bg-white p-3">
          <p className="text-xs font-medium text-violet-900">
            {projectMemory.persistent ? '持久化项目记忆' : '临时项目记忆'}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {projectMemory.persistent
              ? 'Coze S3 已保存并可在重启、重新部署及多实例间恢复本项目'
              : 'S3 暂时不可用，当前运行实例临时保存本项目'}{' '}
            {projectMemory.documentCount} 份文件，
            本次可使用 {projectMemory.relatedDocumentCount} 份关联事实。
            项目记忆加载 {projectMemory.memoryLoadDurationMs}ms。
          </p>
          {projectMemory.decisionContextVersion !== undefined && (
            <p className="mt-1 text-xs font-medium text-violet-800">
              本次分类使用正式 Context v
              {projectMemory.decisionContextVersion}；当前待归档文件尚未写入Context。
            </p>
          )}
          {projectMemory.contextSynthesis && (
            <div className="mt-2 rounded border border-violet-100 bg-violet-50/50 px-2 py-1.5 text-xs leading-5">
              <p className="font-medium text-violet-950">
                项目上下文：
                {PROJECT_STAGE_LABELS[
                  projectMemory.contextSynthesis.latestEvidencedStage
                ] ?? projectMemory.contextSynthesis.latestEvidencedStage}
                （{projectMemory.contextSynthesis.stageConfidence === 'high'
                  ? '高可信'
                  : projectMemory.contextSynthesis.stageConfidence === 'medium'
                    ? '中等可信'
                    : '低可信'}）
              </p>
              <p className="text-muted-foreground">
                {projectMemory.contextSynthesis.status === 'llm_synthesized'
                  ? 'LLM 已综合当前全部有效事实卡片'
                  : '当前使用确定性降级快照'}
                ；事件 {projectMemory.contextSynthesis.eventCount} 个；关系{' '}
                {projectMemory.contextSynthesis.relationCount} 个；冲突{' '}
                {projectMemory.contextSynthesis.conflictCount} 个；上下文 LLM{' '}
                {projectMemory.contextSynthesis.llmCallCount} 次；综合耗时{' '}
                {projectMemory.contextSynthesis.totalDurationMs}ms。
              </p>
              {projectMemory.contextSynthesis.error && (
                <p className="break-words text-amber-700">
                  上下文综合降级：{projectMemory.contextSynthesis.error}
                </p>
              )}
            </div>
          )}
          {!projectMemory.persistent && projectMemory.persistenceWarning && (
            <p className="mt-1 break-words text-xs leading-5 text-amber-700">
              持久化失败：{projectMemory.persistenceWarning}
              {projectMemory.expiresAt
                ? `；临时记忆预计于 ${new Date(projectMemory.expiresAt).toLocaleString()} 失效`
                : ''}
            </p>
          )}
          <details className="mt-2 border-t pt-2">
            <summary className="cursor-pointer text-xs font-medium text-violet-900">
              查看项目记忆明细（{projectMemory.documents.length}）
            </summary>
            <ul className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground">
              {projectMemory.documents.map(document => (
                <li
                  key={document.sourcePath}
                  className="rounded border border-violet-100 bg-violet-50/40 px-2 py-1.5"
                >
                  <p className="break-words font-medium text-violet-950">
                    {document.sourcePath}
                  </p>
                  <p>
                    类型：{document.documentType}；抽取状态：
                    {{
                      extracted: '成功',
                      repaired: '成功（局部字段已校正）',
                      fallback: '降级',
                      type_recovered: '类型已保守恢复',
                    }[document.factStatus]}
                    ；事实完整度：
                    {document.extractionConfidence}；来源：{document.sourceQuality}
                  </p>
                  <p>
                    Agent：{document.selectedFolder ?? document.agentStatus ?? '尚无结论'}
                  </p>
                  {document.warnings.length > 0 && (
                    <p className="break-words text-amber-700">
                      提示：{document.warnings.join('；')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </details>
          {projectMemory.projectContext && (
            <details className="mt-2 border-t pt-2">
              <summary className="cursor-pointer text-xs font-medium text-violet-900">
                查看项目事件时间线（{projectMemory.projectContext.timeline.length}）
              </summary>
              <ol className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground">
                {projectMemory.projectContext.timeline.map((event, index) => (
                  <li
                    key={`${event.eventType}-${event.date ?? 'unknown'}-${index}`}
                    className="rounded border border-violet-100 bg-violet-50/40 px-2 py-1.5"
                  >
                    <p className="font-medium text-violet-950">
                      {event.date ?? '日期待确认'} · {event.title}
                    </p>
                    <p>
                      阶段：{PROJECT_STAGE_LABELS[event.stage] ?? event.stage}；
                      证据：{event.evidenceFiles.join('；')}
                    </p>
                    <p className="break-words">{event.evidence}</p>
                  </li>
                ))}
              </ol>
              {(projectMemory.projectContext.synthesisWarnings?.length ?? 0) > 0 && (
                <p className="mt-2 break-words text-xs leading-5 text-amber-700">
                  上下文提示：
                  {projectMemory.projectContext.synthesisWarnings?.join('；')}
                </p>
              )}
            </details>
          )}
          {projectMemory.reEvaluatedDocuments.length > 0 && (
            <div className="mt-2 border-t pt-2">
              <p className="text-xs font-medium text-green-800">
                新证据已重新判断以下历史文件
              </p>
              <ul className="mt-1 space-y-1 text-xs leading-5 text-green-800">
                {projectMemory.reEvaluatedDocuments.map(document => (
                  <li key={document.sourcePath} className="break-words">
                    {document.sourcePath}：
                    {document.previousFolder ?? '无结论'} →{' '}
                    {document.selectedFolder ?? '仍需复核'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {performance && (
        <details className="rounded-md border border-violet-200 bg-white p-3">
          <summary className="cursor-pointer text-xs font-medium text-violet-900">
            查看性能诊断（总计 {performance.totalDurationMs}ms）
          </summary>
          <div className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground">
            <p>
              {performance.phases
                .filter(item => !item.parentPhase)
                .map(item => `${item.phase} ${item.durationMs}ms`)
                .join('；') || '暂无阶段数据'}
            </p>
            {performance.phases.some(item => item.parentPhase) && (
              <p>
                子阶段：
                {performance.phases
                  .filter(item => item.parentPhase)
                  .map(
                    item =>
                      `${item.parentPhase}.${item.phase} ${item.durationMs}ms`
                  )
                  .join('；')}
              </p>
            )}
            {performance.modelCalls.map((call, index) => (
              <p key={`${call.model}-${index}`} className="break-words">
                LLM {index + 1}：{call.model}，输入 {call.inputCharacters} 字符，
                输出 {call.outputCharacters} 字符/
                {call.outputTokens ?? '未知'} tokens，结束原因{' '}
                {call.finishReason ?? '未知'}，完整耗时 {call.durationMs}ms
                {call.responseHeadersDurationMs === undefined
                  ? '。'
                  : `（响应头 ${call.responseHeadersDurationMs}ms，后续流式生成 ${Math.max(0, call.durationMs - call.responseHeadersDurationMs)}ms）。`}
              </p>
            ))}
          </div>
        </details>
      )}

      <div>
        <p className="text-xs font-medium text-violet-900">执行轨迹</p>
        <ol className="mt-1 space-y-1.5">
          {agent.trace.map((step, index) => (
            <li key={`${step.node}-${index}`} className="flex gap-2 text-xs leading-5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 font-medium text-violet-700">
                {index + 1}
              </span>
              <span className="break-words text-muted-foreground">
                <span className="font-medium text-foreground">
                  {AGENT_NODE_LABELS[step.node]}
                </span>
                ：{step.summary}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-violet-200 pt-2 text-[11px] text-muted-foreground">
        <span>规则：{agent.decision.policyVersion}</span>
        <span>检索轮次：{agent.rounds}</span>
        <span>Agent 调度 LLM：{agent.llmCallCount} 次</span>
      </div>
      <p className="text-[11px] leading-4 text-violet-700">
        Agent 建议会作为人工归档确认的默认选项，但不会绕过人工确认直接写入档案。
      </p>
    </div>
  );
}

// ============ 文件夹树组件 ============
function FolderTree({ node, level = 0, selectedFolder, onSelectFolder }: {
  node: FolderNode; level?: number; selectedFolder: string | null; onSelectFolder: (id: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(level < 2);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedFolder === node.id;

  return (
    <div className="select-none">
      <div
        className={`flex items-center gap-1 py-1.5 px-2 rounded cursor-pointer transition-colors ${isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`}
        style={{ paddingLeft: `${level * 12 + 6}px` }}
        onClick={() => { if (hasChildren) setIsOpen(!isOpen); onSelectFolder(node.id); }}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (<span className="w-4 shrink-0" />)}
        {hasChildren ? (
          isOpen ? <FolderOpen className="h-4 w-4 text-primary shrink-0" /> : <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (<Folder className="h-4 w-4 text-muted-foreground shrink-0" />)}
        <span className="text-sm font-medium truncate">{node.name}</span>
      </div>
      {isOpen && hasChildren && (
        <div>
          {node.children!.map(child => (
            <FolderTree key={child.id} node={child} level={level + 1} selectedFolder={selectedFolder} onSelectFolder={onSelectFolder} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============ 上传区域 ============
function UploadZone({ onFileUpload, disabled }: { onFileUpload: (files: FileList) => void; disabled: boolean }) {
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      className={`relative border-2 border-dashed rounded-lg p-4 md:p-8 text-center transition-all ${disabled ? 'opacity-50 pointer-events-none' : ''} ${isDragging ? 'border-primary bg-primary/5 scale-[1.02]' : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length > 0) onFileUpload(e.dataTransfer.files); }}
    >
      <input
        type="file" multiple
        accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onChange={(e) => { if (e.target.files && e.target.files.length > 0) onFileUpload(e.target.files); }}
      />
      <div className="flex flex-col items-center gap-3">
        <div className={`p-4 rounded-full ${isDragging ? 'bg-primary/10' : 'bg-muted'}`}>
          <Upload className={`h-8 w-8 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <div>
          <p className="font-medium">拖拽文件到此处或点击上传</p>
          <p className="text-sm text-muted-foreground mt-1">支持 PDF、Word、Excel、PPT、TXT、图片（JPG/PNG/GIF/WebP/SVG）等格式</p>
        </div>
      </div>
    </div>
  );
}

// ============ 分类过程面板 ============
function ClassifyProcessPanel({ process }: { process: ClassifyProcess }) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <div className="mt-3 overflow-hidden rounded-lg border">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between bg-muted/50 p-3 text-left transition-colors hover:bg-muted"
      >
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">查看归档判断</span>
          <Badge variant="outline" className="text-xs">
            {process.finalDecision.method === 'agent'
              ? 'Agent 建议'
              : process.finalDecision.method === 'stage'
                ? '阶段判断'
                : '待人工选择'}
          </Badge>
        </div>
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {isExpanded && (
        <div className="bg-background p-4">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-sm leading-5 text-muted-foreground">
              {process.finalDecision.explanation}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 归档一致性提示 ============
const CONSISTENCY_KIND_LABELS: Record<ConsistencyFinding['kind'], string> = {
  transaction_side_conflict: '与交易记录矛盾',
  version_order_conflict: '版本先后矛盾',
  duplicate_stage_mismatch: '重复文件归档不一致',
  missing_companion_document: '档案可能缺件',
};

function ConsistencyPanel({
  report,
  dismissedKeys,
  onDismiss,
}: {
  report: ConsistencyReport | null;
  dismissedKeys: Set<string>;
  onDismiss: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const visible = (report?.findings ?? []).filter(
    finding => !dismissedKeys.has(`${finding.kind}:${finding.sourcePath}`)
  );
  if (visible.length === 0) return null;

  const misfiled = visible.filter(
    finding => finding.kind !== 'missing_companion_document'
  );
  const gaps = visible.filter(
    finding => finding.kind === 'missing_companion_document'
  );

  return (
    <Card className="border-amber-300 bg-amber-50/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm text-amber-900">
            <AlertCircle className="h-4 w-4" />
            {misfiled.length > 0
              ? `${misfiled.length} 份已归档文件的位置与项目证据不符`
              : `${gaps.length} 条档案完整性提示`}
          </CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setExpanded(current => !current)}
          >
            {expanded ? '收起' : '查看详情'}
          </Button>
        </div>
        <CardDescription className="text-xs">
          本次共校验 {report?.checkedCount ?? 0} 份已归档文件
          {(report?.skippedCount ?? 0) > 0
            ? `，另有 ${report?.skippedCount} 份尚未归档已跳过`
            : ''}
          。校验只依据文件事实，不调用模型。
        </CardDescription>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-2 pt-0">
          {visible.map(finding => {
            const key = `${finding.kind}:${finding.sourcePath}`;
            return (
              <div
                key={key}
                className="min-w-0 rounded-lg border border-amber-200 bg-white/70 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">
                      {finding.sourcePath || '项目整体'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {CONSISTENCY_KIND_LABELS[finding.kind]}
                      {finding.currentStage
                        ? ` · 当前归在「${PROJECT_STAGE_LABELS[finding.currentStage] ?? finding.currentStage}」`
                        : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 text-[11px] text-muted-foreground"
                    onClick={() => onDismiss(key)}
                  >
                    忽略
                  </Button>
                </div>
                <p className="mt-2 break-words text-xs leading-5 text-amber-900">
                  {finding.reason}
                </p>
                {finding.evidence.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-muted-foreground">
                    {finding.evidence.map(item => (
                      <li key={item} className="break-words">
                        依据：{item}
                      </li>
                    ))}
                  </ul>
                )}
                {finding.relatedSourcePaths.length > 0 && (
                  <p className="mt-1 break-all text-[11px] text-muted-foreground">
                    相关文件：{finding.relatedSourcePaths.join('、')}
                  </p>
                )}
              </div>
            );
          })}
          <p className="pt-1 text-[11px] leading-4 text-muted-foreground">
            这些是确定性校验结果，不代表其余文件一定归对——校验器对没有数字或日期
            关联的文件本来就无话可说。要调整位置请到下方档案区移动文件。
          </p>
        </CardContent>
      )}
    </Card>
  );
}

// ============ 分类结果项 ============
function ClassifyResultItem({
  result,
  showLegacyClassification,
  showModelStageDecision,
  onConfirmArchive,
  onCancelArchive,
}: {
  result: ClassifyResult;
  showLegacyClassification: boolean;
  showModelStageDecision: boolean;
  onConfirmArchive: (
    clientId: string,
    archiveTitle: string,
    folder: ArchiveFolder
  ) => void;
  onCancelArchive: (clientId: string) => void;
}) {
  const agentFolder = result.agentDecision?.decision.selectedFolder ?? null;
  const legacyClassification = result.legacyClassification;
  const modelStage = result.modelStageDecision;
  const modelStagePending = Boolean(result.modelStagePending && !modelStage);
  const modelFolder = modelStage?.decision?.selectedFolder ?? null;
  // 只有两边都给出了明确阶段才谈得上一致或分歧；任一方沉默时不下判断。
  const modelAgreesWithAgent =
    modelStage?.decision?.businessStage && result.agentDecision
      ? modelStage.decision.businessStage ===
        result.agentDecision.decision.businessStage
      : null;
  const comparisonColumns =
    1 +
    (showLegacyClassification ? 1 : 0) +
    (showModelStageDecision ? 1 : 0);
  const agentConfidence = result.agentDecision?.decision.confidence ?? 0;
  const agentPending = Boolean(result.agentPending && !result.agentDecision);
  const agentNeedsReview = !agentPending && result.agentDecision?.status !== 'decided';
  const agentSelectionValue = agentFolder
    ? agentFolder.folderId
    : '';
  const [archiveTitle, setArchiveTitle] = useState(
    result.fileName.replace(/\.[^.]+$/, '')
  );
  const [selectedFolderId, setSelectedFolderId] = useState(
    agentSelectionValue
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (result.archiveStatus !== 'pending' || !agentSelectionValue) return;
    setSelectedFolderId(current => current || agentSelectionValue);
  }, [agentSelectionValue, result.archiveStatus]);
  const selectedFolder = SYSTEM_ARCHIVE_FOLDERS.find(
    folder => folder.folderId === selectedFolderId
  );
  const isArchiving = result.archiveStatus === 'archiving';
  const needsConfirmation =
    result.requiresArchiveConfirmation &&
    !result.archived &&
    result.archiveStatus !== 'cancelled';
  const classificationsDisagree = Boolean(
    agentFolder &&
    legacyClassification?.targetFolder &&
    agentFolder.folderId !== legacyClassification.targetFolder.folderId
  );

  return (
    <div
      className={`w-full min-w-0 overflow-hidden rounded-lg border bg-background ${
        agentPending
          ? 'border-l-4 border-l-sky-400'
          : result.agentDecision?.status === 'decided'
          ? 'border-l-4 border-l-violet-500'
          : 'border-l-4 border-l-amber-500'
      }`}
    >
      <div className="flex min-w-0 items-start gap-2.5 border-b bg-muted/20 p-3">
        <div className={`mt-0.5 shrink-0 rounded-md p-1.5 ${agentPending ? 'bg-sky-100' : agentNeedsReview ? 'bg-amber-100' : 'bg-violet-100'}`}>
          {agentPending
            ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
            : agentNeedsReview
            ? <AlertCircle className="h-4 w-4 text-amber-600" />
            : <Brain className="h-4 w-4 text-violet-600" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium leading-5">{result.fileName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{(result.fileSize / 1024).toFixed(1)} KB</span>
            <span>·</span>
            <span>{agentPending ? 'Agent 分析中' : `Agent 置信度 ${agentConfidence}%`}</span>
            <Badge variant="outline" className="border-violet-300 bg-violet-50 text-[10px] text-violet-700">
              Agent 主模式
            </Badge>
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-3 p-3">
        <div
          className={`grid gap-3 ${
            comparisonColumns === 3
              ? 'lg:grid-cols-3'
              : comparisonColumns === 2
                ? 'lg:grid-cols-2'
                : ''
          }`}
        >
          <div className="min-w-0 rounded-lg border border-violet-200 bg-violet-50/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-violet-900">
                <Brain className="h-3.5 w-3.5" />
                Agent 分类结果
              </p>
              <Badge
                variant="outline"
                className={agentNeedsReview
                  ? 'border-amber-300 bg-amber-50 text-[10px] text-amber-700'
                  : 'border-green-300 bg-green-50 text-[10px] text-green-700'}
              >
                {agentPending ? '分析中' : agentNeedsReview ? '需要复核' : '证据充分'}
              </Badge>
            </div>
            <p className="mt-2 break-words text-sm font-medium leading-5 text-violet-950">
              {agentFolder
                ? agentFolder.folderPath.join(' / ')
                : agentPending
                  ? '规则预判已返回，正在等待 Agent'
                  : '暂未形成唯一分类建议'}
            </p>
            <p className="mt-1 break-words text-[11px] leading-4 text-violet-700">
              业务阶段：{PROJECT_STAGE_LABELS[
                result.agentDecision?.decision.businessStage ??
                  result.businessStage ??
                  'unknown'
              ] ?? '待确认'}
              {' · '}
              文件类型：{result.documentType ?? '待识别'}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Progress value={agentConfidence} className="h-1.5 flex-1" />
              <span className="text-xs text-violet-800">{agentConfidence}%</span>
            </div>
            <p className="mt-2 break-words text-xs leading-5 text-violet-800">
              {result.agentDecision?.decision.reasoning ??
                (agentPending
                  ? 'Agent 正在抽取结构化事实并结合项目 Context 判断。'
                  : 'Agent 未成功返回结果，请查看详情中的诊断信息。')}
            </p>
            {(result.agentDecision?.decision.evidence.length ?? 0) > 0 && (
              <ul className="mt-2 space-y-1 border-t border-violet-200 pt-2 text-[11px] leading-4 text-green-800">
                {result.agentDecision?.decision.evidence.slice(0, 2).map(evidence => (
                  <li key={evidence} className="break-words">✓ {evidence}</li>
                ))}
              </ul>
            )}
          </div>

          {showModelStageDecision && (
            <div className="min-w-0 rounded-lg border border-sky-200 bg-sky-50/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-sky-900">
                  <Sparkles className="h-3.5 w-3.5" />
                  模型阶段判断（影子）
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {modelStage?.decision?.requiresHumanReview && (
                    <Badge
                      variant="outline"
                      className="border-amber-300 bg-amber-50 text-[10px] text-amber-700"
                    >
                      需要复核
                    </Badge>
                  )}
                  {modelAgreesWithAgent !== null && (
                    <Badge
                      variant="outline"
                      className={modelAgreesWithAgent
                        ? 'border-green-300 bg-green-50 text-[10px] text-green-700'
                        : 'border-amber-300 bg-amber-50 text-[10px] text-amber-700'}
                    >
                      {modelAgreesWithAgent ? '与规则一致' : '与规则分歧'}
                    </Badge>
                  )}
                </div>
              </div>
              <p className="mt-2 break-words text-sm font-medium leading-5 text-sky-950">
                {modelFolder
                  ? modelFolder.folderPath.join(' / ')
                  : modelStagePending
                    ? '模型判断进行中'
                    : modelStage?.status === 'fallback'
                      ? '模型判断失败，本次以规则结论为准'
                      : '模型认为证据不足以确定阶段'}
              </p>
              <p className="mt-1 break-words text-[11px] leading-4 text-sky-700">
                业务阶段：{PROJECT_STAGE_LABELS[
                  modelStage?.decision?.businessStage ?? 'unknown'
                ] ?? '待确认'}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Progress
                  value={modelStage?.decision?.confidence ?? 0}
                  className="h-1.5 flex-1"
                />
                <span className="text-xs text-sky-800">
                  {modelStage?.decision?.confidence ?? 0}%
                </span>
              </div>
              <p className="mt-2 break-words text-xs leading-5 text-sky-800">
                {modelStage?.decision?.reasoning ??
                  modelStage?.error ??
                  (modelStagePending
                    ? '模型正在基于结构化事实和项目 Context 独立判断阶段。'
                    : '暂无模型判断结果。')}
              </p>
              {(modelStage?.decision?.evidence.length ?? 0) > 0 && (
                <ul className="mt-2 space-y-1 border-t border-sky-200 pt-2 text-[11px] leading-4 text-green-800">
                  {modelStage?.decision?.evidence.slice(0, 2).map(evidence => (
                    <li key={evidence} className="break-words">✓ {evidence}</li>
                  ))}
                </ul>
              )}
              {(modelStage?.decision?.contradictions.length ?? 0) > 0 && (
                <ul className="mt-2 space-y-1 border-t border-sky-200 pt-2 text-[11px] leading-4 text-amber-800">
                  {modelStage?.decision?.contradictions.slice(0, 2).map(item => (
                    <li key={item} className="break-words">⚠ {item}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2 border-t border-sky-200 pt-2 text-[10px] leading-4 text-sky-600">
                影子模式：此结论仅供对照，不影响下方的归档建议。
              </p>
            </div>
          )}

          {showLegacyClassification && (
            <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50/80 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-800">
                  <Zap className="h-3.5 w-3.5" />
                  规则阶段对照
                </p>
                {legacyClassification ? (
                  <Badge variant="outline" className="bg-white text-[10px]">
                    {result.rulePreliminary ? '快速预判' : `${legacyClassification.confidence}%`}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-white text-[10px] text-muted-foreground">
                    本次未运行
                  </Badge>
                )}
              </div>
              <p className="mt-2 break-words text-sm font-medium leading-5 text-slate-900">
                {legacyClassification?.targetFolder
                  ? legacyClassification.targetFolder.folderPath.join(' / ')
                  : legacyClassification
                    ? '未能确定业务阶段'
                    : '该文件上传时规则对照开关处于关闭状态'}
              </p>
              <p className="mt-2 break-words text-xs leading-5 text-slate-600">
                {legacyClassification?.reasoning ??
                  '打开开关后，新上传文件会同时运行确定性阶段规则用于并列对照。'}
              </p>
            </div>
          )}
        </div>

        {classificationsDisagree && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs leading-5 text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            Agent 与规则阶段判断不一致，请结合证据后确认最终归档位置。
          </div>
        )}

        {result.archived && (
          <div className="min-w-0 rounded-md bg-green-50 p-2.5 text-sm text-green-700">
            <div className="flex items-center gap-1.5 font-medium">
              <Archive className="h-4 w-4 shrink-0" />
              已按人工确认结果完成归档
            </div>
            <p className="mt-1 break-words text-xs leading-5">
              项目：{result.archived.projectName}
              <br />
              文件名：<span className="font-mono break-all">{result.archived.archivedName}</span>
            </p>
          </div>
        )}

        {needsConfirmation && (
          <div className="min-w-0 space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3">
            <div>
              <p className="text-sm font-medium text-amber-900">确认 Agent 建议并归档</p>
              <p className="mt-1 text-xs leading-5 text-amber-700">
                Agent 建议已作为默认选项；证据不足时请人工选择分类。确认后才会正式归档并更新项目 Context。
              </p>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label className="text-xs" htmlFor={`archive-folder-${result.clientId}`}>
                最终归档文件夹
              </Label>
              <Select
                value={selectedFolderId}
                disabled={isArchiving}
                onValueChange={setSelectedFolderId}
              >
                <SelectTrigger id={`archive-folder-${result.clientId}`} className="w-full bg-background">
                  <SelectValue placeholder="请选择业务阶段文件夹" />
                </SelectTrigger>
                <SelectContent>
                  {SYSTEM_ARCHIVE_FOLDERS.map(folder => (
                    <SelectItem
                      key={folder.folderId}
                      value={folder.folderId}
                    >
                      {folder.folderPath.slice(1).join(' / ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label className="text-xs" htmlFor={`archive-title-${result.clientId}`}>
                档案标题（不含扩展名）
              </Label>
              <Input
                id={`archive-title-${result.clientId}`}
                className="w-full min-w-0 bg-background"
                value={archiveTitle}
                maxLength={50}
                disabled={isArchiving}
                onChange={(event) => setArchiveTitle(event.target.value)}
                placeholder="请输入档案标题"
              />
              <p className="break-words text-[11px] leading-4 text-muted-foreground">
                {archiveTitle.length}/50 字；扩展名及重名序号由系统自动补充。
              </p>
            </div>
            {result.archiveError && (
              <p className="break-words text-xs text-destructive">{result.archiveError}</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={isArchiving}
                onClick={() => onCancelArchive(result.clientId)}
              >
                取消归档
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={!archiveTitle.trim() || !selectedFolder || isArchiving}
                onClick={() => {
                  if (selectedFolder) {
                    onConfirmArchive(result.clientId, archiveTitle.trim(), selectedFolder);
                  }
                }}
              >
                {isArchiving && <Loader2 className="h-4 w-4 animate-spin" />}
                确认归档
              </Button>
            </div>
          </div>
        )}

        {result.archiveStatus === 'cancelled' && (
          <div className="flex items-center gap-2 rounded-md bg-muted p-2.5 text-sm text-muted-foreground">
            <X className="h-4 w-4 shrink-0" />
            已取消归档
          </div>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-center gap-1.5 border"
          onClick={() => setDetailsOpen(true)}
        >
          <Eye className="h-4 w-4" />
          查看分类详情
        </Button>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="flex h-[85dvh] max-h-[760px] max-w-3xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="break-all pr-6">分类详情：{result.fileName}</DialogTitle>
            <DialogDescription>
              查看 Agent 证据、项目 Context 和处理过程
            </DialogDescription>
          </DialogHeader>
          <ScrollArea type="always" className="min-h-0 flex-1 pr-5">
            <div className="space-y-4 pb-4">
              {result.agentDecision && (
                <AgentDecisionPanel
                  agent={result.agentDecision}
                  projectMemory={result.projectSessionMemory}
                  performance={result.performance}
                />
              )}

              {showLegacyClassification && legacyClassification && (
                <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="flex items-center gap-2 text-sm font-medium">
                      <Zap className="h-4 w-4" />规则阶段判断详情
                    </h4>
                    <Badge variant="outline">{legacyClassification.confidence}%</Badge>
                  </div>
                  <p className="break-words text-sm font-medium">
                    {legacyClassification.targetFolder
                      ? legacyClassification.targetFolder.folderPath.join(' / ')
                      : '未能确定归档阶段'}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {legacyClassification.reasoning || '暂无详细理由'}
                  </p>
                  <ClassifyProcessPanel process={result.process} />
                </div>
              )}

              {result.contentPreview && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">文件内容摘要</h4>
                  <div className="whitespace-pre-wrap break-words rounded-lg border p-3 text-sm text-muted-foreground">
                    {result.contentPreview}
                  </div>
                </div>
              )}

            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============ 创建项目对话框 ============
function CreateProjectDialog({ onCreated }: { onCreated: (project: Project) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() })
      });
      const data = await res.json();
      if (data.project) {
        onCreated(data.project);
        setName('');
        setDescription('');
        setOpen(false);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <Plus className="h-4 w-4" /> 新建项目
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建新项目</DialogTitle>
          <DialogDescription>创建一个投资项目，文件将归档到该项目文件夹下</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">项目名称 *</Label>
            <Input id="project-name" placeholder="例如：某科技公司A轮投资" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-desc">项目描述（可选）</Label>
            <Input id="project-desc" placeholder="简要描述项目信息" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={handleCreate} disabled={!name.trim() || loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============ 归档文件树节点类型 ============
interface ArchiveTreeNode {
  name: string;
  path: string;
  folderPath?: string[];
  type: 'folder' | 'file';
  children?: ArchiveTreeNode[];
  file?: {
    id: string;
    originalName: string;
    archivedName: string;
    fileSize: number;
    mimeType: string;
    archivedAt: string;
    confidence: number;
  };
}

// ============ 移动文件对话框 ============

// 移动对话框中的文件夹树选择节点
function MoveFolderNode({ node, level, selectedId, onSelect, path, blockedPath }: {
  node: FolderNode;
  level: number;
  selectedId: string;
  onSelect: (id: string, name: string, path: string[]) => void;
  path: string[];
  blockedPath?: string[];
}) {
  const [isOpen, setIsOpen] = useState(level < 2);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;
  const currentPath = [...path, node.name];
  const isBlocked = Boolean(
    blockedPath &&
    currentPath.length >= blockedPath.length &&
    blockedPath.every((segment, index) => currentPath[index] === segment)
  );

  return (
    <div className="select-none">
      <div
        className={`flex items-center gap-1 py-1.5 px-2 rounded transition-colors ${
          isBlocked
            ? 'cursor-not-allowed opacity-40'
            : `cursor-pointer ${isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`
        }`}
        style={{ paddingLeft: `${level * 12 + 6}px` }}
        onClick={() => {
          if (isBlocked) return;
          if (hasChildren) setIsOpen(!isOpen);
          onSelect(node.id, node.name, currentPath);
        }}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (<span className="w-4 shrink-0" />)}
        {isSelected ? (
          <div className="w-4 h-4 rounded-full border-2 border-primary flex items-center justify-center shrink-0">
            <div className="w-2 h-2 rounded-full bg-primary" />
          </div>
        ) : (
          <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/30 flex items-center justify-center shrink-0" />
        )}
        <Folder className={`h-4 w-4 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className={`text-sm truncate ${isSelected ? 'font-medium' : ''}`}>{node.name}</span>
      </div>
      {isOpen && hasChildren && (
        <div>
          {node.children!.map(child => (
            <MoveFolderNode
              key={child.id}
              node={child}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              path={currentPath}
              blockedPath={blockedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MoveArchiveDialog({
  targetName,
  currentPath,
  fileCount,
  isFolder,
  blockedPath,
  onMove,
  onCancel,
  moving,
  existingFiles,
}: {
  targetName: string;
  currentPath: string[];
  fileCount: number;
  isFolder: boolean;
  blockedPath?: string[];
  onMove: (folderId: string, folderPath: string[]) => void;
  onCancel: () => void;
  moving: boolean;
  existingFiles: ArchivedFile[];
}) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string[]>([]);
  const [newSubfolder, setNewSubfolder] = useState("");

  // 合并 FOLDER_STRUCTURE + 用户新建的文件夹
  const mergedTree = useMemo(() => {
    const customPaths = existingFiles
      .map(f => f.folderPath)
      .filter(p => p.length > 0);
    return mergeFolderStructure(FOLDER_STRUCTURE, customPaths);
  }, [existingFiles]);

  const handleSelect = (id: string, _name: string, path: string[]) => {
    setSelectedId(id);
    setSelectedPath(path);
    setNewSubfolder("");
  };

  // 计算最终目标
  const getFinalTarget = () => {
    if (!selectedId) return null;
    if (newSubfolder.trim()) {
      const subName = newSubfolder.trim();
      return {
        folderId: `${selectedId}-${subName}`,
        folderPath: [...selectedPath, subName],
      };
    }
    return {
      folderId: selectedId,
      folderPath: selectedPath,
    };
  };

  // 目标路径预览
  const selectedDestination = selectedId
    ? (newSubfolder.trim()
      ? [...selectedPath, newSubfolder.trim()]
      : selectedPath)
    : [];
  const targetPreview = selectedId
    ? [...selectedDestination, ...(isFolder ? [targetName] : [])].join(' / ')
    : '';

  return (
    <Dialog open={true} onOpenChange={() => onCancel()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            移动归档{isFolder ? '文件夹' : '文件'}
          </DialogTitle>
          <DialogDescription>
            将「<span className="font-medium text-foreground">{targetName}</span>」
            {isFolder ? `及其中 ${fileCount} 个文件` : ''}移动到新的分类文件夹
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="text-xs text-muted-foreground mb-2">
            当前位置：{currentPath.join(' / ')}
          </div>

          <ScrollArea className="h-[260px] border rounded-lg p-2">
            <MoveFolderNode
              node={mergedTree}
              level={0}
              selectedId={selectedId}
              onSelect={handleSelect}
              path={[]}
              blockedPath={blockedPath}
            />
          </ScrollArea>

          {selectedId && (
            <div className="mt-3 space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                新建子文件夹（可选，在选中的分类下创建）
              </Label>
              <Input
                placeholder="输入子文件夹名称，留空则移动到选中的分类"
                value={newSubfolder}
                onChange={(e) => setNewSubfolder(e.target.value)}
                maxLength={100}
                className="h-8 text-sm"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">目标路径：{targetPreview}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">{newSubfolder.length}/100</span>
              </div>
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onCancel} disabled={moving}>
            取消
          </Button>
          <Button
            onClick={() => {
              const target = getFinalTarget();
              if (target) onMove(target.folderId, target.folderPath);
            }}
            disabled={!selectedId || moving}
          >
            {moving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
                移动中...
              </>
            ) : (
              '确认移动'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============ 归档文件树组件 ============
type CtxMenuItem = { label: string; icon: React.ReactNode; action: () => void; destructive?: boolean };
type CtxMenuState = { x: number; y: number; items: CtxMenuItem[] } | null;

function collectNodeFileIds(node: ArchiveTreeNode): string[] {
  if (node.type === 'file') {
    return node.file ? [node.file.id] : [];
  }
  return node.children?.flatMap(collectNodeFileIds) || [];
}

function ArchiveTreeItem({ node, level, onDownload, onDeleteNode, onMoveNode, onRenameNode, setCtxMenu }: {
  node: ArchiveTreeNode;
  level: number;
  onDownload: (fileId: string) => void;
  onDeleteNode: (node: ArchiveTreeNode) => void;
  onMoveNode: (node: ArchiveTreeNode) => void;
  onRenameNode: (node: ArchiveTreeNode) => void;
  setCtxMenu: (v: CtxMenuState) => void;
}) {
  const [isOpen, setIsOpen] = useState(level < 2);
  const hasChildren = node.children && node.children.length > 0;
  const fileCount = collectNodeFileIds(node).length;

  if (node.type === 'file' && node.file) {
    const meta = `${(node.file.fileSize / 1024).toFixed(1)} KB · ${new Date(node.file.archivedAt).toLocaleDateString('zh-CN')} · 置信度 ${node.file.confidence}%`;
    const fileId = node.file.id;
    const contextItems = [
      { label: '重命名', icon: <Pencil className="h-3.5 w-3.5 mr-2" />, action: () => onRenameNode(node) },
      { label: '移动', icon: <ArrowRightLeft className="h-3.5 w-3.5 mr-2" />, action: () => onMoveNode(node) },
      { label: '下载', icon: <Download className="h-3.5 w-3.5 mr-2" />, action: () => onDownload(fileId) },
      { label: '删除', icon: <Trash2 className="h-3.5 w-3.5 mr-2 text-destructive" />, action: () => onDeleteNode(node), destructive: true },
    ];
    return (
      <div
        className="flex items-center gap-1 py-1 px-2 rounded hover:bg-muted/50 transition-colors group"
        style={{ paddingLeft: `${level * 12 + 6}px` }}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY, items: contextItems });
        }}
      >
        <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
        <p className="text-xs font-medium truncate flex-1 min-w-0" title={`${node.file.archivedName}\n${meta}`}>{node.file.archivedName}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 opacity-60 group-hover:opacity-100">
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-28">
            <DropdownMenuItem onClick={() => onRenameNode(node)}>
              <Pencil className="h-3.5 w-3.5 mr-2" />重命名
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onMoveNode(node)}>
              <ArrowRightLeft className="h-3.5 w-3.5 mr-2" />移动
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDownload(fileId)}>
              <Download className="h-3.5 w-3.5 mr-2" />下载
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onClick={() => onDeleteNode(node)}>
              <Trash2 className="h-3.5 w-3.5 mr-2" />删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const folderContextItems: CtxMenuItem[] = [
    ...(level > 0
      ? [{
          label: '重命名文件夹',
          icon: <Pencil className="h-3.5 w-3.5 mr-2" />,
          action: () => onRenameNode(node),
        }, {
          label: '移动文件夹',
          icon: <ArrowRightLeft className="h-3.5 w-3.5 mr-2" />,
          action: () => onMoveNode(node),
        }]
      : []),
    {
      label: `删除文件夹（${fileCount} 个文件）`,
      icon: <Trash2 className="h-3.5 w-3.5 mr-2 text-destructive" />,
      action: () => onDeleteNode(node),
      destructive: true,
    },
  ];

  return (
    <div className="select-none">
      <div
        className="flex items-center gap-1 py-1 px-2 rounded cursor-pointer hover:bg-muted/50 transition-colors"
        style={{ paddingLeft: `${level * 12 + 6}px` }}
        onClick={() => setIsOpen(!isOpen)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY, items: folderContextItems });
        }}
      >
        {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        {isOpen ? <FolderOpen className="h-3.5 w-3.5 text-primary shrink-0" /> : <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        <span className="text-xs font-medium truncate">{node.name}</span>
        {fileCount > 0 && <Badge variant="outline" className="ml-auto text-[10px] px-1 py-0 shrink-0">{fileCount}</Badge>}
      </div>
      {isOpen && hasChildren && (
        <div>
          {node.children!.map((child, idx) => (
            <ArchiveTreeItem
              key={`${child.path}-${idx}`}
              node={child}
              level={level + 1}
              onDownload={onDownload}
              onDeleteNode={onDeleteNode}
              onMoveNode={onMoveNode}
              onRenameNode={onRenameNode}
              setCtxMenu={setCtxMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============ 归档文件列表 ============
interface ArchiveOperationTarget {
  name: string;
  path: string[];
  isFolder: boolean;
  files: ArchivedFile[];
}

function ArchivedFilesList({
  projectId,
  archiveTree,
  archivedFiles,
  loading,
  onFilesChanged,
}: {
  projectId: string;
  archiveTree: ArchiveTreeNode[];
  archivedFiles: ArchivedFile[];
  loading: boolean;
  onFilesChanged: (projectId: string, fileCountDelta: number) => void;
}) {
  const [tree, setTree] = useState<ArchiveTreeNode[]>(archiveTree);
  const [files, setFiles] = useState<ArchivedFile[]>(archivedFiles);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [moveTarget, setMoveTarget] = useState<ArchiveOperationTarget | null>(null);
  const [moving, setMoving] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  const [deleteTarget, setDeleteTarget] = useState<ArchiveOperationTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ArchiveOperationTarget | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameFileName = renameTarget?.isFolder
    ? ''
    : (renameTarget?.files[0]?.archivedName || '');
  const renameFileDotIndex = renameFileName.lastIndexOf('.');
  const renameFileExtension = renameFileDotIndex > 0
    ? renameFileName.slice(renameFileDotIndex)
    : '';

  useEffect(() => {
    setTree(archiveTree);
    setFiles(archivedFiles);
  }, [archiveTree, archivedFiles]);

  const handleDownload = (fileId: string) => {
    window.open(`/api/archive?download=${fileId}&id=${fileId}`, '_blank');
  };

  const getOperationTarget = (node: ArchiveTreeNode): ArchiveOperationTarget | null => {
    const fileIds = new Set(collectNodeFileIds(node));
    const targetFiles = files.filter(file => fileIds.has(file.id));
    if (targetFiles.length === 0) return null;

    return {
      name: node.type === 'file' ? targetFiles[0].archivedName : node.name,
      path: node.type === 'file'
        ? targetFiles[0].folderPath
        : (node.folderPath || []),
      isFolder: node.type === 'folder',
      files: targetFiles,
    };
  };

  const handleDelete = (node: ArchiveTreeNode) => {
    const target = getOperationTarget(node);
    if (!target) return;
    setDeleteError(null);
    setDeleteTarget(target);
  };

  const handleMoveRequest = (node: ArchiveTreeNode) => {
    const target = getOperationTarget(node);
    if (target) setMoveTarget(target);
  };

  const handleRenameRequest = (node: ArchiveTreeNode) => {
    const target = getOperationTarget(node);
    if (!target) return;

    const dotIndex = target.name.lastIndexOf('.');
    setRenameValue(
      !target.isFolder && dotIndex > 0
        ? target.name.slice(0, dotIndex)
        : target.name
    );
    setRenameError(null);
    setRenameTarget(target);
  };

  const confirmRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;

    setRenaming(true);
    setRenameError(null);
    try {
      const response = await fetch('/api/archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          renameTarget.isFolder
            ? {
                action: 'rename-folder',
                projectId,
                sourcePath: renameTarget.path,
                newName: renameValue.trim(),
              }
            : {
                action: 'rename-file',
                id: renameTarget.files[0].id,
                newTitle: renameValue.trim(),
              }
        ),
      });
      const responseData = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseData?.error || '重命名失败，请重试');
      }

      setRenameTarget(null);
      onFilesChanged(projectId, 0);
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : '重命名失败，请重试'
      );
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      const ids = deleteTarget.files.map(file => file.id);
      const response = await fetch('/api/archive/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || '删除失败，请重试');
      }

      const deletedIds = new Set(ids);
      setFiles(prev => prev.filter(file => !deletedIds.has(file.id)));
      setTree(prev => ids.reduce(
        (currentTree, fileId) => removeFileFromTree(currentTree, fileId),
        prev
      ));
      setDeleteTarget(null);
      onFilesChanged(projectId, -ids.length);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败，请重试');
    } finally {
      setDeleting(false);
    }
  };

  const handleMove = async (targetFolderId: string, targetFolderPath: string[]) => {
    if (!moveTarget) return;
    setMoving(true);
    try {
      const moves = moveTarget.files.map(file => {
        if (!moveTarget.isFolder) {
          return {
            id: file.id,
            folderId: targetFolderId,
            folderPath: targetFolderPath,
          };
        }

        const relativePath = file.folderPath.slice(moveTarget.path.length);
        const folderPath = [...targetFolderPath, moveTarget.name, ...relativePath];
        return {
          id: file.id,
          folderId: `${targetFolderId}-${folderPath.slice(targetFolderPath.length).join('-')}`,
          folderPath,
        };
      });
      const res = await fetch('/api/archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moves }),
      });
      const moveData = await res.json().catch(() => null);
      if (!res.ok) throw new Error(moveData?.error || '移动失败');
      setMoveTarget(null);
      onFilesChanged(projectId, 0);
    } catch {
      alert('移动文件失败，请重试');
    } finally {
      setMoving(false);
    }
  };

  const handleDownloadAll = () => {
    setDownloadingAll(true);
    window.open(`/api/archive/download-all?projectId=${projectId}`, '_blank');
    setTimeout(() => setDownloadingAll(false), 1500);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">加载归档文件...</span>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Archive className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm">暂无归档文件</p>
        <p className="text-xs mt-1">上传文件后将自动归档到此处</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <span className="text-xs text-muted-foreground">共 {files.length} 个文件</span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 shrink-0"
          onClick={handleDownloadAll}
          disabled={downloadingAll}
        >
          {downloadingAll ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          一键下载全部
        </Button>
      </div>
      <div className="border rounded-lg p-2 bg-muted/20">
        {tree.map((node, idx) => (
          <ArchiveTreeItem
            key={`${node.path}-${idx}`}
            node={node}
            level={0}
            onDownload={handleDownload}
            onDeleteNode={handleDelete}
            onMoveNode={handleMoveRequest}
            onRenameNode={handleRenameRequest}
            setCtxMenu={setCtxMenu}
          />
        ))}
      </div>

      {/* Right-click Context Menu */}
      {ctxMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
        >
          <div
            className="absolute bg-popover border rounded-md shadow-md py-1 min-w-[100px]"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {ctxMenu.items.map((item, i) => (
              <button
                key={i}
                className={`w-full flex items-center px-3 py-1.5 text-xs hover:bg-muted transition-colors ${item.destructive ? 'text-destructive' : ''}`}
                onClick={() => { item.action(); setCtxMenu(null); }}
              >
                {item.icon}{item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Move File or Folder Dialog */}
      {moveTarget && (
        <MoveArchiveDialog
          targetName={moveTarget.name}
          currentPath={moveTarget.path}
          fileCount={moveTarget.files.length}
          isFolder={moveTarget.isFolder}
          blockedPath={moveTarget.isFolder ? moveTarget.path : undefined}
          onMove={handleMove}
          onCancel={() => setMoveTarget(null)}
          moving={moving}
          existingFiles={files}
        />
      )}

      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setRenameTarget(null);
            setRenameError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              重命名归档{renameTarget?.isFolder ? '文件夹' : '文件'}
            </DialogTitle>
            <DialogDescription>
              {renameTarget?.isFolder
                ? `文件夹中的 ${renameTarget.files.length} 个文件会同步移动到新路径。`
                : `文件扩展名 ${renameFileExtension || '（无）'} 将保持不变。`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="archive-rename">
              新{renameTarget?.isFolder ? '文件夹' : '文件'}名称
            </Label>
            <div className="flex items-center gap-1">
              <Input
                id="archive-rename"
                autoFocus
                value={renameValue}
                maxLength={renameTarget?.isFolder ? 100 : 50}
                disabled={renaming}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && renameValue.trim() && !renaming) {
                    void confirmRename();
                  }
                }}
              />
              {!renameTarget?.isFolder && renameFileExtension && (
                <span className="text-sm text-muted-foreground">
                  {renameFileExtension}
                </span>
              )}
            </div>
            {renameError && (
              <p className="text-sm text-destructive">{renameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={renaming}
              onClick={() => setRenameTarget(null)}
            >
              取消
            </Button>
            <Button
              disabled={!renameValue.trim() || renaming}
              onClick={() => void confirmRename()}
            >
              {renaming ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  重命名中...
                </>
              ) : (
                '确认重命名'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              确认删除归档{deleteTarget?.isFolder ? '文件夹' : '文件'}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.isFolder ? (
                <>
                  你选择了文件夹「{deleteTarget.name}」。删除该文件夹将同时永久删除其中的
                  {' '}<strong>{deleteTarget.files.length} 个文件</strong>及其归档记录，此操作不可恢复。
                </>
              ) : (
                <>
                  将永久删除「{deleteTarget?.name}」的存储文件和归档记录，此操作不可恢复。
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  删除中...
                </>
              ) : (
                '确认删除'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// 将归档文件中的实际 folderPath 合并到 FOLDER_STRUCTURE 中，保留用户新建的子文件夹
function mergeFolderStructure(base: FolderNode, customPaths: string[][]): FolderNode {
  const merged = JSON.parse(JSON.stringify(base)) as FolderNode;

  for (const path of customPaths) {
    let currentChildren = merged.children || [];

    for (let i = 1; i < path.length; i++) {
      const segment = path[i];
      let found = currentChildren.find(c => c.name === segment);

      if (!found) {
        found = { name: segment, id: `custom-${path.slice(0, i + 1).join('/')}`, children: [] };
        currentChildren.push(found);
      }

      if (!found.children) found.children = [];
      currentChildren = found.children;
    }
  }

  return merged;
}

// 从树中移除文件节点
function removeFileFromTree(nodes: ArchiveTreeNode[], fileId: string): ArchiveTreeNode[] {
  return nodes
    .map(node => {
      if (node.type === 'file' && node.file?.id === fileId) return null;
      if (node.children) {
        node.children = removeFileFromTree(node.children, fileId);
      }
      return node;
    })
    .filter((n): n is ArchiveTreeNode => n !== null)
    .filter(n => n.type === 'file' || (n.children && n.children.length > 0));
}

// ============ 分析记录面板 ============
interface AnalysisRecord {
  id: string;
  originalName: string;
  archivedName: string;
  projectName: string;
  folderPath: string[];
  fileSize: number;
  confidence: number;
  archivedAt: string;
}

function AnalysisHistoryPanel({
  records,
  loading,
}: {
  records: AnalysisRecord[];
  loading: boolean;
}) {
  if (loading && records.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">加载分析记录...</span>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm">暂无分析记录</p>
        <p className="text-xs mt-1">上传并分类文件后将在此显示记录</p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">共 {records.length} 条记录</span>
      </div>
      <div className="w-full min-w-0 space-y-2">
        {records.map((record) => (
          <div
            key={record.id}
            className="w-full min-w-0 overflow-hidden rounded-lg border bg-background p-3 transition-colors hover:bg-muted/30"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <div className="mt-0.5 shrink-0 rounded bg-primary/10 p-1.5">
                <FileText className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className="break-all text-sm font-medium leading-5"
                  title={record.originalName}
                >
                  {record.originalName}
                </p>
              </div>
            </div>

            <div className="mt-3 min-w-0 rounded-md bg-muted/50 p-2.5">
              <p className="text-[11px] text-muted-foreground">归档后名称</p>
              <p
                className="mt-1 break-all font-mono text-xs leading-5"
                title={record.archivedName}
              >
                  {record.archivedName}
              </p>
            </div>

            <div className="mt-3 min-w-0">
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Folder className="h-3 w-3 shrink-0" />
                归档位置
              </p>
              <p className="mt-1 break-words [overflow-wrap:anywhere] text-xs leading-5 text-muted-foreground">
                {record.folderPath.join(' / ')}
              </p>
            </div>

            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {(record.fileSize / 1024).toFixed(1)} KB
              </Badge>
              <span className="flex min-w-0 items-center gap-1">
                <Clock className="h-3 w-3 shrink-0" />
                {new Date(record.archivedAt).toLocaleString('zh-CN', {
                  year: 'numeric', month: '2-digit', day: '2-digit',
                  hour: '2-digit', minute: '2-digit'
                })}
              </span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                置信度 {record.confidence}%
              </Badge>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ 主页面 ============
export default function Home() {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [results, setResults] = useState<ClassifyResult[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [showLegacyClassification, setShowLegacyClassification] = useState(true);
  const [showModelStageDecision, setShowModelStageDecision] = useState(true);

  // 项目管理
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0);
  const [contextRefreshKey, setContextRefreshKey] = useState(0);
  const [projectContextState, setProjectContextState] =
    useState<ProjectSessionMemoryResult | null>(null);
  const [consistencyReport, setConsistencyReport] =
    useState<ConsistencyReport | null>(null);
  // 用户忽略过的提示不再重复弹。切换项目时清空；持久化留待后续。
  const [dismissedFindingKeys, setDismissedFindingKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [projectContextLoading, setProjectContextLoading] = useState(false);
  const [projectContextRebuilding, setProjectContextRebuilding] = useState(false);
  const [projectContextError, setProjectContextError] = useState<string | null>(null);
  const [archiveTree, setArchiveTree] = useState<ArchiveTreeNode[]>([]);
  const [archivedFiles, setArchivedFiles] = useState<ArchivedFile[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const loadedArchiveProjectIdRef = useRef<string | null>(null);
  // 新增项目动画
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  const [deleteProjectTargetId, setDeleteProjectTargetId] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null);
  const [renameProjectTargetId, setRenameProjectTargetId] = useState<string | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');
  const [renameProjectDescription, setRenameProjectDescription] = useState('');
  const [renamingProject, setRenamingProject] = useState(false);
  const [renameProjectError, setRenameProjectError] = useState<string | null>(null);

  const deleteProjectTarget = deleteProjectTargetId
    ? projects.find(project => project.id === deleteProjectTargetId)
    : null;
  const renameProjectTarget = renameProjectTargetId
    ? projects.find(project => project.id === renameProjectTargetId)
    : null;

  // 加载项目列表
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => {
        setProjects(data.projects || []);
        setSelectedProjectId(currentId => currentId || data.projects?.[0]?.id || '');
      });
  }, []);

  // 归档树和分析记录共享同一次读取；同项目刷新时保留旧内容，避免整块闪烁。
  useEffect(() => {
    if (!selectedProjectId) {
      loadedArchiveProjectIdRef.current = null;
      setArchiveTree([]);
      setArchivedFiles([]);
      setArchiveLoading(false);
      return;
    }

    const controller = new AbortController();
    const isProjectChange =
      loadedArchiveProjectIdRef.current !== selectedProjectId;

    if (isProjectChange) {
      setArchiveTree([]);
      setArchivedFiles([]);
      setArchiveLoading(true);
    }

    fetch(`/api/archive?projectId=${selectedProjectId}&tree=true`, {
      signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error('获取归档文件失败');
        return response.json();
      })
      .then(data => {
        loadedArchiveProjectIdRef.current = selectedProjectId;
        setArchiveTree(data.tree || []);
        setArchivedFiles(data.files || []);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        loadedArchiveProjectIdRef.current = selectedProjectId;
        // 后台校准失败时保留当前数据，下一次操作或切换项目会再次读取。
      })
      .finally(() => {
        if (!controller.signal.aborted) setArchiveLoading(false);
      });

    return () => controller.abort();
  }, [selectedProjectId, archiveRefreshKey]);

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectContextState(null);
      setConsistencyReport(null);
      setProjectContextLoading(false);
      return;
    }
    // 换项目时清掉忽略记录，避免不同项目之间互相压制提示。
    setDismissedFindingKeys(new Set());
    const controller = new AbortController();
    setProjectContextLoading(true);
    setProjectContextError(null);
    fetch(
      `/api/project-context?projectId=${encodeURIComponent(selectedProjectId)}`,
      { signal: controller.signal }
    )
      .then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(data?.error || '读取项目Context失败');
        }
        setProjectContextState(data.projectContext ?? null);
        setConsistencyReport(data.consistency ?? null);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setProjectContextError(
          error instanceof Error ? error.message : '读取项目Context失败'
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectContextLoading(false);
      });
    return () => controller.abort();
  }, [selectedProjectId, contextRefreshKey]);

  const handleRebuildProjectContext = useCallback(async () => {
    if (!selectedProjectId) return;
    setProjectContextRebuilding(true);
    setProjectContextError(null);
    try {
      const response = await fetch('/api/project-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProjectId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || '重建项目Context失败');
      }
      setProjectContextState(data.projectContext ?? null);
      setConsistencyReport(data.consistency ?? null);
    } catch (error) {
      setProjectContextError(
        error instanceof Error ? error.message : '重建项目Context失败'
      );
    } finally {
      setProjectContextRebuilding(false);
    }
  }, [selectedProjectId]);

  const handleProjectCreated = (project: Project) => {
    setProjects(prev => [project, ...prev]);
    setSelectedProjectId(project.id);
    // 触发动画
    setNewProjectId(project.id);
    setTimeout(() => setNewProjectId(null), 600);
  };

  const handleArchivedFilesChanged = useCallback((
    changedProjectId: string,
    fileCountDelta: number
  ) => {
    // 先在前端立即更新数量，让用户无需等待网络请求。
    if (fileCountDelta !== 0) {
      setProjects(prev => prev.map(project =>
        project.id === changedProjectId
          ? {
              ...project,
              fileCount: Math.max(0, project.fileCount + fileCountDelta),
            }
          : project
      ));
    }

    // 同时刷新归档记录，并从数据库重新读取项目计数进行校准。
    setArchiveRefreshKey(prev => prev + 1);
    setContextRefreshKey(prev => prev + 1);
    fetch('/api/projects')
      .then(response => response.json())
      .then(data => {
        if (Array.isArray(data.projects)) {
          setProjects(data.projects);
        }
      })
      .catch(() => {
        // 保留已经完成的前端即时计数，等待下次刷新再校准。
      });
  }, []);

  const handleDeleteProject = (id: string) => {
    setDeleteProjectError(null);
    setDeleteProjectTargetId(id);
  };

  const handleRenameProject = (project: Project) => {
    setRenameProjectError(null);
    setRenameProjectName(project.name);
    setRenameProjectDescription(project.description || '');
    setRenameProjectTargetId(project.id);
  };

  const confirmRenameProject = async () => {
    if (!renameProjectTarget) return;

    const name = renameProjectName.trim();
    if (!name) {
      setRenameProjectError('项目名称不能为空');
      return;
    }

    setRenamingProject(true);
    setRenameProjectError(null);
    try {
      const response = await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: renameProjectTarget.id,
          name,
          description: renameProjectDescription.trim(),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.project) {
        throw new Error(data?.error || '项目重命名失败，请重试');
      }

      const renamedProject = data.project as Project;
      setProjects(prev => prev.map(project =>
        project.id === renamedProject.id
          ? { ...project, ...renamedProject }
          : project
      ));
      setResults(prev => prev.map(result =>
        result.sourceProjectId === renamedProject.id && result.archived
          ? {
              ...result,
              archived: {
                ...result.archived,
                projectName: renamedProject.name,
              },
            }
          : result
      ));
      setArchiveRefreshKey(prev => prev + 1);
      setRenameProjectTargetId(null);
      setRenameProjectName('');
      setRenameProjectDescription('');
    } catch (error) {
      setRenameProjectError(
        error instanceof Error ? error.message : '项目重命名失败，请重试'
      );
    } finally {
      setRenamingProject(false);
    }
  };

  const confirmDeleteProject = async () => {
    if (!deleteProjectTarget) return;

    setDeletingProject(true);
    setDeleteProjectError(null);
    try {
      const response = await fetch(
        `/api/projects?id=${encodeURIComponent(deleteProjectTarget.id)}`,
        { method: 'DELETE' }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || '删除项目失败，请重试');
      }

      const deletedId = deleteProjectTarget.id;
      const nextSelectedProjectId =
        projects.find(project => project.id !== deletedId)?.id || '';
      setProjects(prev => prev.filter(project => project.id !== deletedId));
      setSelectedProjectId(currentId =>
        currentId === deletedId ? nextSelectedProjectId : currentId
      );
      setDeleteProjectTargetId(null);
    } catch (error) {
      setDeleteProjectError(
        error instanceof Error ? error.message : '删除项目失败，请重试'
      );
    } finally {
      setDeletingProject(false);
    }
  };

  const handleConfirmArchive = async (
    clientId: string,
    archiveTitle: string,
    selectedFolder: ArchiveFolder
  ) => {
    const pendingResult = results.find(result => result.clientId === clientId);
    if (
      (!pendingResult?.sourceFile && !pendingResult?.sourceStorageKey) ||
      !pendingResult.sourceProjectId
    ) {
      setResults(prev => prev.map(result =>
        result.clientId === clientId
          ? { ...result, archiveStatus: 'error', archiveError: '待归档文件信息已丢失，请重新上传' }
          : result
      ));
      return;
    }

    setResults(prev => prev.map(result =>
      result.clientId === clientId
        ? { ...result, archiveStatus: 'archiving', archiveError: undefined }
        : result
    ));

    try {
      const archiveConfidence =
        pendingResult.agentDecision?.decision.confidence ??
        pendingResult.confidence;
      const archiveReasoning =
        pendingResult.agentDecision?.decision.reasoning ??
        pendingResult.reasoning;
      const response = pendingResult.sourceStorageKey
        ? await fetch('/api/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              storageKey: pendingResult.sourceStorageKey,
              originalName: pendingResult.fileName,
              fileSize: pendingResult.fileSize,
              mimeType: pendingResult.sourceMimeType,
              projectId: pendingResult.sourceProjectId,
              folderId: selectedFolder.folderId,
              archiveTitle,
              confidence: archiveConfidence,
              reasoning: archiveReasoning,
              sourcePath: pendingResult.sourcePath || pendingResult.fileName,
              documentFacts: pendingResult.documentFacts,
            }),
          })
        : await (() => {
            const formData = new FormData();
            formData.append('file', pendingResult.sourceFile!);
            formData.append('projectId', pendingResult.sourceProjectId!);
            formData.append('folderId', selectedFolder.folderId);
            formData.append('archiveTitle', archiveTitle);
            formData.append('confidence', String(archiveConfidence));
            formData.append('reasoning', archiveReasoning);
            formData.append(
              'sourcePath',
              pendingResult.sourcePath || pendingResult.fileName
            );
            formData.append(
              'documentFacts',
              JSON.stringify(pendingResult.documentFacts ?? null)
            );
            return fetch('/api/archive', { method: 'POST', body: formData });
          })();
      const data = await response.json();

      if (!response.ok || !data.archived) {
        throw new Error(data.error || '归档失败，请重试');
      }

      const reEvaluatedByPath = new Map<string, AgentDecisionResult>(
        (
          data.projectContext?.reEvaluatedDocuments ?? []
        ).map((document: ProjectSessionMemoryResult['reEvaluatedDocuments'][number]) => [
          document.sourcePath,
          document.agentDecision,
        ] as const)
      );
      setResults(prev => prev.map(result => {
        if (result.clientId === clientId) {
          return {
              ...result,
              targetFolder: selectedFolder,
              suggestedArchiveTitle: archiveTitle,
              requiresArchiveConfirmation: false,
              archiveStatus: 'archived',
              archiveError: undefined,
              sourceFile: undefined,
              sourceStorageKey: undefined,
              archived: data.archived,
              performance: data.performance
                ? {
                    totalDurationMs:
                      (result.performance?.totalDurationMs ?? 0) +
                      data.performance.totalDurationMs,
                    phases: [
                      ...(result.performance?.phases ?? []),
                      ...data.performance.phases.map(
                        (item: {
                          phase: string;
                          durationMs: number;
                          parentPhase?: string;
                        }) => ({
                          ...item,
                          phase: `archive.${item.phase}`,
                          parentPhase: item.parentPhase
                            ? `archive.${item.parentPhase}`
                            : undefined,
                        })
                      ),
                    ],
                    modelCalls: [
                      ...(result.performance?.modelCalls ?? []),
                      ...data.performance.modelCalls,
                    ],
                  }
                : result.performance,
              projectSessionMemory:
                data.projectContext
                  ? {
                      ...data.projectContext,
                      decisionContextVersion:
                        result.projectSessionMemory?.decisionContextVersion,
                    }
                  : result.projectSessionMemory,
            };
        }
        const updatedAgent = reEvaluatedByPath.get(
          result.sourcePath || result.fileName
        );
        return updatedAgent ? { ...result, agentDecision: updatedAgent } : result;
      }));
      setArchiveRefreshKey(prev => prev + 1);
      if (data.projectContext) {
        setProjectContextState(data.projectContext);
      } else {
        setContextRefreshKey(prev => prev + 1);
      }
      if (data.contextRebuildPending) {
        setProjectContextRebuilding(true);
        setProjectContextError(null);
        void fetch('/api/project-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: pendingResult.sourceProjectId }),
        })
          .then(async rebuildResponse => {
            const rebuildData = await rebuildResponse.json().catch(() => null);
            if (!rebuildResponse.ok) {
              throw new Error(
                rebuildData?.error || '归档成功，但后台 Context 更新失败'
              );
            }
            const rebuiltContext = rebuildData?.projectContext ?? null;
            setProjectContextState(rebuiltContext);
            setConsistencyReport(rebuildData?.consistency ?? null);
            const rebuiltDecisions = new Map<string, AgentDecisionResult>(
              (rebuiltContext?.reEvaluatedDocuments ?? []).map(
                (document: ProjectSessionMemoryResult['reEvaluatedDocuments'][number]) => [
                  document.sourcePath,
                  document.agentDecision,
                ] as const
              )
            );
            if (rebuiltDecisions.size > 0) {
              setResults(current => current.map(item => {
                const rebuilt = rebuiltDecisions.get(
                  item.sourcePath || item.fileName
                );
                return rebuilt ? { ...item, agentDecision: rebuilt } : item;
              }));
            }
          })
          .catch(error => {
            setProjectContextError(
              error instanceof Error
                ? error.message
                : '归档成功，但后台 Context 更新失败'
            );
          })
          .finally(() => setProjectContextRebuilding(false));
      }
      fetch('/api/projects')
        .then(response => response.json())
        .then(data => setProjects(data.projects || []));
    } catch (error) {
      setResults(prev => prev.map(result =>
        result.clientId === clientId
          ? {
              ...result,
              archiveStatus: 'error',
              archiveError: error instanceof Error ? error.message : '归档失败，请重试',
            }
          : result
      ));
    }
  };

  const handleCancelArchive = (clientId: string) => {
    const pendingResult = results.find(result => result.clientId === clientId);
    if (pendingResult?.sourceStorageKey && pendingResult.sourceProjectId) {
      const params = new URLSearchParams({
        storageKey: pendingResult.sourceStorageKey,
        projectId: pendingResult.sourceProjectId,
        sourcePath: pendingResult.sourcePath || pendingResult.fileName,
      });
      void fetch(`/api/uploads?${params}`, { method: 'DELETE' });
    }

    setResults(prev => prev.map(result =>
      result.clientId === clientId
        ? {
            ...result,
            requiresArchiveConfirmation: false,
            archiveStatus: 'cancelled',
            archiveError: undefined,
            sourceFile: undefined,
            sourceStorageKey: undefined,
          }
        : result
    ));
  };

  const handleFileUpload = useCallback(async (files: FileList) => {
    if (!selectedProjectId) {
      alert('请先选择或创建一个项目');
      return;
    }
    if (results.some(result => result.requiresArchiveConfirmation)) {
      alert('请先确认或取消当前待归档文件，再上传新一批文件');
      return;
    }

    setIsProcessing(true);
    setProcessingProgress(0);
    setResults([]);

    const totalFiles = files.length;
    let processedFiles = 0;

    for (const file of Array.from(files)) {
      const clientId = crypto.randomUUID();
      const uploadedSourcePath = file.webkitRelativePath || file.name;
      const quickRule = showLegacyClassification
        ? inferBusinessStage({ sourcePath: uploadedSourcePath })
        : null;
      const quickRuleFolder = quickRule?.selectedStage
        ? getFolderForBusinessStage(quickRule.selectedStage)
        : null;
      setResults(prev => [
        ...prev,
        {
          clientId,
          fileName: file.name,
          sourcePath: uploadedSourcePath,
          fileSize: file.size,
          targetFolder: quickRuleFolder,
          confidence: quickRule?.confidence ?? 0,
          reasoning:
            quickRule?.reasoning ?? '文件上传完成后将运行 Agent 分类。',
          process: {
            finalDecision: {
              method: quickRuleFolder ? 'stage' : 'none',
              explanation: quickRuleFolder
                ? '文件名规则已形成快速预判，等待 Agent 使用正文和项目 Context 复核。'
                : '文件名规则证据不足，等待 Agent 使用正文和项目 Context 判断。',
            },
          },
          classificationMode: showLegacyClassification
            ? 'comparison'
            : 'agent',
          businessStage: quickRule?.selectedStage,
          legacyClassification: quickRule
            ? {
                targetFolder: quickRuleFolder,
                confidence: quickRule.confidence,
                reasoning: `快速预判仅使用文件名：${quickRule.reasoning}`,
              }
            : undefined,
          requiresArchiveConfirmation: false,
          agentPending: true,
          modelStagePending: showModelStageDecision,
          rulePreliminary: Boolean(quickRule),
        },
      ]);
      let uploadedStorageKey = '';
      let chunkUploadId = '';
      try {
        const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk

        if (file.size > CHUNK_SIZE) {
          // 大文件：每个 2MB 分片立即存入 S3，最后无状态合并。
          chunkUploadId = crypto.randomUUID();
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
          const chunkKeys = new Array<string>(totalChunks);
          const CHUNK_UPLOAD_CONCURRENCY = 3;

          for (
            let batchStart = 0;
            batchStart < totalChunks;
            batchStart += CHUNK_UPLOAD_CONCURRENCY
          ) {
            const indexes = Array.from(
              {
                length: Math.min(
                  CHUNK_UPLOAD_CONCURRENCY,
                  totalChunks - batchStart
                ),
              },
              (_, offset) => batchStart + offset
            );
            const uploaded = await Promise.all(indexes.map(async index => {
              const start = index * CHUNK_SIZE;
              const end = Math.min(start + CHUNK_SIZE, file.size);
              const chunk = file.slice(start, end);
              const chunkRes = await fetch('/api/uploads/chunk', {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'x-upload-id': chunkUploadId,
                  'x-chunk-index': String(index),
                  'x-chunk-total': String(totalChunks),
                  'x-project-id': selectedProjectId,
                  'x-file-name': encodeURIComponent(file.name),
                },
                body: chunk,
              });
              const chunkData = await chunkRes.json().catch(() => null);
              if (!chunkRes.ok) {
                throw new Error(
                  chunkData?.error ||
                  `分片 ${index + 1}/${totalChunks} 上传失败（HTTP ${chunkRes.status}）`
                );
              }
              if (!chunkData?.chunkKey) {
                throw new Error(
                  `分片 ${index + 1}/${totalChunks} 未返回 S3 地址`
                );
              }
              return { index, chunkKey: String(chunkData.chunkKey) };
            }));
            for (const item of uploaded) chunkKeys[item.index] = item.chunkKey;
          }

          const completeResponse = await fetch('/api/uploads/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'complete',
              uploadId: chunkUploadId,
              projectId: selectedProjectId,
              fileName: encodeURIComponent(file.name),
              mimeType: file.type || 'application/octet-stream',
              chunkKeys,
            }),
          });
          const completeData = await completeResponse.json().catch(() => null);
          if (!completeResponse.ok || !completeData?.storageKey) {
            throw new Error(
              completeData?.error ||
              `合并上传文件失败（HTTP ${completeResponse.status}）`
            );
          }
          uploadedStorageKey = completeData.storageKey;
          chunkUploadId = '';
        } else {
          // 小文件：直接上传
          const uploadResponse = await fetch('/api/uploads', {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'x-project-id': selectedProjectId,
              'x-file-name': encodeURIComponent(file.name),
            },
            body: file,
          });
          const uploadData = await uploadResponse.json().catch(() => null);
          if (!uploadResponse.ok || !uploadData?.storageKey) {
            throw new Error(
              uploadData?.error ||
              `上传到 S3 失败（HTTP ${uploadResponse.status}）`
            );
          }
          uploadedStorageKey = uploadData.storageKey;
        }

        const response = await fetch('/api/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storageKey: uploadedStorageKey,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || 'application/octet-stream',
            projectId: selectedProjectId,
            autoArchive: false,
            agentDecision: true,
            legacyDecision: showLegacyClassification,
            modelStageDecision: showModelStageDecision,
            sourcePath: file.webkitRelativePath || file.name,
          }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) {
          const statusHint = response.status === 413
            ? '文件超过当前服务允许的上传大小'
            : response.status === 504
              ? '文件处理超时'
              : `请求失败（HTTP ${response.status}）`;
          const serverMessage = [result?.error, result?.details]
            .filter(Boolean)
            .join('：');
          throw new Error(serverMessage || statusHint);
        }
        if (!result) {
          throw new Error('服务器没有返回有效的分类结果');
        }

        if (result.projectSessionMemory) {
          setProjectContextState(result.projectSessionMemory);
        }
        const reEvaluatedByPath = new Map<string, AgentDecisionResult>(
          (
            result.projectSessionMemory?.reEvaluatedDocuments ?? []
          ).map((document: ProjectSessionMemoryResult['reEvaluatedDocuments'][number]) => [
            document.sourcePath,
            document.agentDecision,
          ] as const)
        );
        setResults(prev => {
          const completed: ClassifyResult = {
            ...result,
            clientId,
            sourcePath: uploadedSourcePath,
            legacyClassification:
              result.classificationMode === 'comparison'
                ? {
                    targetFolder: result.targetFolder,
                    confidence: result.confidence,
                    reasoning: result.reasoning,
                  }
                : undefined,
            requiresArchiveConfirmation: true,
            sourceStorageKey: uploadedStorageKey,
            sourceMimeType: file.type || 'application/octet-stream',
            sourceProjectId: selectedProjectId,
            archiveStatus: 'pending',
            agentPending: false,
            modelStagePending: false,
            rulePreliminary: false,
          };
          return prev.map(existing => {
            if (existing.clientId === clientId) return completed;
            const updatedAgent = reEvaluatedByPath.get(
              existing.sourcePath || existing.fileName
            );
            return updatedAgent
              ? { ...existing, agentDecision: updatedAgent }
              : existing;
          });
        });

        if (result.contextRebuildPending && selectedProjectId) {
          setProjectContextRebuilding(true);
          setProjectContextError(null);
          void fetch('/api/project-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: selectedProjectId }),
          })
            .then(async rebuildResponse => {
              const rebuildData = await rebuildResponse.json().catch(() => null);
              if (!rebuildResponse.ok) {
                throw new Error(
                  rebuildData?.error || '分类成功，但后台 Context 更新失败'
                );
              }
              const rebuiltContext = rebuildData?.projectContext ?? null;
              setProjectContextState(rebuiltContext);
              const rebuiltDecisions = new Map<string, AgentDecisionResult>(
                (rebuiltContext?.reEvaluatedDocuments ?? []).map(
                  (document: ProjectSessionMemoryResult['reEvaluatedDocuments'][number]) => [
                    document.sourcePath,
                    document.agentDecision,
                  ] as const
                )
              );
              if (rebuiltDecisions.size > 0) {
                setResults(current =>
                  current.map(item => {
                    const rebuilt = rebuiltDecisions.get(
                      item.sourcePath || item.fileName
                    );
                    return rebuilt ? { ...item, agentDecision: rebuilt } : item;
                  })
                );
              }
            })
            .catch(error => {
              setProjectContextError(
                error instanceof Error
                  ? error.message
                  : '分类成功，但后台 Context 更新失败'
              );
            })
            .finally(() => setProjectContextRebuilding(false));
        }
      } catch (error) {
        if (chunkUploadId) {
          await fetch('/api/uploads/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'abort',
              uploadId: chunkUploadId,
              projectId: selectedProjectId,
            }),
          }).catch(() => null);
        }
        if (uploadedStorageKey) {
          const params = new URLSearchParams({
            storageKey: uploadedStorageKey,
            projectId: selectedProjectId,
            sourcePath: file.webkitRelativePath || file.name,
          });
          void fetch(`/api/uploads?${params}`, { method: 'DELETE' });
        }
        const errorMessage = error instanceof Error
          ? error.message
          : '未知错误';
        setResults(prev => prev.map(existing =>
          existing.clientId === clientId
            ? {
                ...existing,
                targetFolder: null,
                confidence: 0,
                reasoning: `文件处理失败：${errorMessage}`,
                process: {
                  finalDecision: {
                    method: 'none' as const,
                    explanation: `文件处理失败：${errorMessage}`,
                  },
                },
                agentPending: false,
                rulePreliminary: false,
              }
            : existing
        ));
      }
      processedFiles++;
      setProcessingProgress(Math.round((processedFiles / totalFiles) * 100));
    }

    setIsProcessing(false);
    setArchiveRefreshKey(prev => prev + 1);
    // 刷新项目列表以更新文件计数
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => setProjects(data.projects || []));
  }, [
    selectedProjectId,
    results,
    showLegacyClassification,
    showModelStageDecision,
  ]);

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const archiveDataMatchesSelection =
    loadedArchiveProjectIdRef.current === selectedProjectId;
  const visibleArchiveTree = archiveDataMatchesSelection ? archiveTree : [];
  const visibleArchivedFiles = archiveDataMatchesSelection ? archivedFiles : [];
  const visibleArchiveLoading =
    archiveLoading || (Boolean(selectedProjectId) && !archiveDataMatchesSelection);
  const hasPendingArchiveConfirmation = results.some(
    result => result.requiresArchiveConfirmation
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg md:text-2xl font-bold">投资项目档案管理系统</h1>
              <p className="text-xs md:text-sm text-muted-foreground">智能文件分类 · 自动归档 · 按项目管理</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-sm">国创致远</Badge>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-6 lg:grid-cols-12 gap-4 lg:gap-6">
          {/* Left Sidebar: Folder Structure + Projects */}
          <div className="md:col-span-2 lg:col-span-3 space-y-4">
            {/* Project Selection */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base md:text-lg flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-primary" />
                    项目管理
                  </CardTitle>
                  <CreateProjectDialog onCreated={handleProjectCreated} />
                </div>
                <CardDescription>选择项目后上传文件将自动归档</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                {projects.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <p className="text-sm">暂无项目</p>
                    <p className="text-xs mt-1">请先创建一个项目</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[160px] md:h-[200px]">
                    <div className="space-y-1 pr-1">
                      {projects.map(project => (
                        <div
                          key={project.id}
                          className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-all duration-300 group ${
                            selectedProjectId === project.id
                              ? 'bg-primary/10 text-primary'
                              : 'hover:bg-muted'
                          } ${
                            newProjectId === project.id
                              ? 'animate-in slide-in-from-top-2 fade-in duration-500 bg-primary/5 ring-1 ring-primary/20'
                              : ''
                          }`}
                          onClick={() => setSelectedProjectId(project.id)}
                        >
                          <Building2 className="h-4 w-4 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{project.name}</p>
                            {project.description && (
                              <p
                                className="text-xs text-muted-foreground truncate"
                                title={project.description}
                              >
                                {project.description}
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground">{project.fileCount} 个文件</p>
                          </div>
                          <div className="flex shrink-0 items-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title="编辑项目信息"
                              aria-label={`编辑项目 ${project.name}`}
                              className="h-7 w-7 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRenameProject(project);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title="删除项目"
                              aria-label={`删除项目 ${project.name}`}
                              className="h-7 w-7 shrink-0 text-destructive opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDeleteProject(project.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>

            {/* Project-level committed Context */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Brain className="h-5 w-5 text-violet-600" />
                    项目 Context
                  </CardTitle>
                  {projectContextState && (
                    <Badge
                      variant="outline"
                      className={
                        projectContextState.contextState.status === 'clean'
                          ? 'border-green-300 text-green-700'
                          : projectContextState.contextState.status === 'dirty'
                            ? 'border-amber-300 text-amber-700'
                            : 'border-red-300 text-red-700'
                      }
                    >
                      {{
                        clean: '最新',
                        dirty: '需要更新',
                        rebuilding: '更新中',
                        failed: '更新失败',
                      }[projectContextState.contextState.status]}
                    </Badge>
                  )}
                </div>
                <CardDescription>
                  只使用已成功归档且当前有效的文件生成
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 pt-0 text-xs leading-5">
                {projectContextLoading ? (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在读取项目Context…
                  </p>
                ) : projectContextState ? (
                  <>
                    <p>
                      Context v{projectContextState.contextState.version}；依据{' '}
                      {projectContextState.documentCount} 份正式文件
                    </p>
                    {projectContextState.projectContext?.contextStatus ===
                      'deterministic_fallback' && (
                      <p className="rounded border border-orange-200 bg-orange-50 px-2 py-1 text-orange-800">
                        本版 Context 使用确定性规则生成；具体原因可在下方数据质量提示中查看。
                      </p>
                    )}
                    <p className="text-muted-foreground">
                      最晚证据阶段：
                      {PROJECT_STAGE_LABELS[
                        projectContextState.projectContext
                          ?.latestEvidencedStage ?? 'unknown'
                      ] ?? '尚未确定'}
                      ；事件{' '}
                      {projectContextState.projectContext?.timeline.length ?? 0} 个
                    </p>
                    {projectContextState.contextState.status === 'failed' &&
                      projectContextState.contextState.lastError && (
                        <div
                          role="alert"
                          className="rounded border border-red-200 bg-red-50 p-2 text-red-800"
                        >
                          <p className="font-medium">Context 更新失败原因</p>
                          <p className="mt-1 break-words">
                            {projectContextState.contextState.lastError}
                          </p>
                          <p className="mt-1 text-[11px] text-red-700">
                            系统仍保留上一版可用 Context；修复原因后可重新生成。
                          </p>
                        </div>
                      )}
                    {projectContextState.persistenceWarning && (
                      <div className="rounded border border-orange-200 bg-orange-50 p-2 text-orange-800">
                        <p className="font-medium">项目记忆持久化告警</p>
                        <p className="mt-1 break-words">
                          {projectContextState.persistenceWarning}
                        </p>
                      </div>
                    )}
                    {(projectContextState.projectContext?.synthesisWarnings
                      ?.length ?? 0) > 0 && (
                      <details className="rounded border border-slate-200 bg-slate-50 p-2 text-slate-700">
                        <summary className="cursor-pointer font-medium">
                          查看 Context 数据质量提示
                        </summary>
                        <ul className="mt-1 space-y-1">
                          {projectContextState.projectContext?.synthesisWarnings?.map(
                            warning => (
                              <li key={warning} className="break-words">
                                {warning}
                              </li>
                            )
                          )}
                        </ul>
                      </details>
                    )}
                    {projectContextState.contextState.dirtyReasons.length > 0 && (
                      <ul className="space-y-1 rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
                        {projectContextState.contextState.dirtyReasons.map(reason => (
                          <li key={reason} className="break-words">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    )}
                    {projectContextState.projectContext &&
                      projectContextState.projectContext.timeline.length > 0 && (
                        <details className="border-t pt-2">
                          <summary className="cursor-pointer font-medium text-violet-800">
                            查看事件时间线
                          </summary>
                          <ol className="mt-2 space-y-2 text-muted-foreground">
                            {projectContextState.projectContext.timeline.map(
                              (event, index) => (
                                <li key={`${event.eventType}-${index}`}>
                                  <span className="font-medium text-foreground">
                                    {event.date ?? '日期待确认'} · {event.title}
                                  </span>
                                  <br />
                                  证据：{event.evidenceFiles.join('；')}
                                </li>
                              )
                            )}
                          </ol>
                        </details>
                      )}
                    {projectContextState.rebuildHistory &&
                      projectContextState.rebuildHistory.length > 0 && (
                        <details className="border-t pt-2">
                          <summary className="cursor-pointer font-medium text-violet-800">
                            查看 Context 重建历史（{projectContextState.rebuildHistory.length} 次）
                          </summary>
                          <div className="mt-2 space-y-3">
                            {projectContextState.rebuildHistory.map((entry, index) => (
                              <div
                                key={`${entry.timestamp}-${index}`}
                                className={`rounded-lg border p-3 ${
                                  entry.status === 'success'
                                    ? 'border-green-200 bg-green-50'
                                    : 'border-red-200 bg-red-50'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                                        entry.trigger === 'add_file'
                                          ? 'bg-blue-100 text-blue-800'
                                          : entry.trigger === 'delete_file'
                                            ? 'bg-orange-100 text-orange-800'
                                            : 'bg-purple-100 text-purple-800'
                                      }`}
                                    >
                                      {entry.trigger === 'add_file'
                                        ? '新增文件'
                                        : entry.trigger === 'delete_file'
                                          ? '删除文件'
                                          : '手动重建'}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {new Date(entry.timestamp).toLocaleString('zh-CN')}
                                    </span>
                                  </div>
                                  <span
                                    className={`text-xs font-medium ${
                                      entry.status === 'success' ? 'text-green-700' : 'text-red-700'
                                    }`}
                                  >
                                    {entry.status === 'success' ? '✓ 成功' : '✗ 失败'}
                                  </span>
                                </div>
                                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                  <div>
                                    <span className="text-muted-foreground">耗时：</span>
                                    <span className="font-medium">
                                      {entry.totalDurationMs >= 1000
                                        ? `${(entry.totalDurationMs / 1000).toFixed(1)}s`
                                        : `${entry.totalDurationMs}ms`}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">版本：</span>
                                    <span className="font-medium">
                                      v{entry.contextVersion}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">阶段变化：</span>
                                    <span className="font-medium">
                                      {entry.stageTransition
                                        ? `${entry.stageTransition.from} → ${entry.stageTransition.to}`
                                        : '未变化'}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">重评估：</span>
                                    <span className="font-medium">
                                      {entry.reEvaluatedDocumentCount}/{entry.totalDocumentCount} 份
                                      {entry.reevaluationMode === 'incremental' && (
                                        <span className="ml-1 text-blue-600">(增量)</span>
                                      )}
                                    </span>
                                  </div>
                                  {entry.llmCallCount > 0 && (
                                    <>
                                      <div>
                                        <span className="text-muted-foreground">LLM 调用：</span>
                                        <span className="font-medium">
                                          {entry.llmCallCount} 次 · 综合 {entry.synthesisDurationMs}ms
                                        </span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Token：</span>
                                        <span className="font-medium">
                                          {entry.inputTokens.toLocaleString()} in /{' '}
                                          {entry.outputTokens.toLocaleString()} out
                                        </span>
                                      </div>
                                    </>
                                  )}
                                </div>
                                {entry.error && (
                                  <div className="mt-2 rounded bg-red-100 p-2 text-xs text-red-800">
                                    <span className="font-medium">错误：</span>
                                    {entry.error}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    <Button
                      type="button"
                      variant={
                        projectContextState.contextState.status === 'clean'
                          ? 'outline'
                          : 'default'
                      }
                      size="sm"
                      className="w-full"
                      disabled={projectContextRebuilding || !selectedProjectId}
                      onClick={() => void handleRebuildProjectContext()}
                    >
                      {projectContextRebuilding && (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      )}
                      重新生成项目Context
                    </Button>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    选择项目后显示正式Context。
                  </p>
                )}
                {projectContextError && (
                  <p className="break-words text-destructive">
                    {projectContextError}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Folder Structure */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base md:text-lg flex items-center gap-2">
                  <Folder className="h-5 w-5 text-primary" />
                  文件夹结构
                </CardTitle>
                <CardDescription>基于《国创致远-投资项目档案管理》文档</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[calc(100vh-440px)] min-h-[160px] max-h-[400px]">
                  <FolderTree node={FOLDER_STRUCTURE} selectedFolder={selectedFolder} onSelectFolder={setSelectedFolder} />
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Middle: Upload + Results */}
          <div className="md:col-span-4 lg:col-span-4 space-y-4">
            {/* Upload Section */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base md:text-lg flex items-center gap-2">
                  <Upload className="h-5 w-5 text-primary" />
                  文件上传
                </CardTitle>
                <CardDescription>
                  {selectedProject
                    ? `当前项目：${selectedProject.name} — Agent 分析后由你确认归档`
                    : '请先在左侧选择或创建一个项目'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UploadZone
                  onFileUpload={handleFileUpload}
                  disabled={!selectedProjectId || hasPendingArchiveConfirmation}
                />
                {hasPendingArchiveConfirmation && (
                  <p className="mt-2 text-xs text-amber-700">
                    请先确认或取消下方 Agent 建议，再上传下一批文件。
                  </p>
                )}
                {isProcessing && (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      <span className="text-sm">正在处理文件...</span>
                    </div>
                    <Progress value={processingProgress} className="h-2" />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Archived Files */}
            <Card className="flex min-h-0 flex-col">
              <CardHeader className="pb-3 shrink-0">
                <CardTitle className="text-base md:text-lg flex items-center gap-2">
                  <Archive className="h-5 w-5 text-primary" />
                  已归档文件
                </CardTitle>
                <CardDescription>
                  {selectedProject
                    ? `${selectedProject.name} — ${selectedProject.fileCount} 个文件`
                    : '请选择一个项目查看归档文件'}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0 flex-1 min-h-0">
                <ScrollArea className="h-[280px] md:h-[360px] lg:h-[440px]">
                  {selectedProjectId ? (
                    <ArchivedFilesList
                      projectId={selectedProjectId}
                      archiveTree={visibleArchiveTree}
                      archivedFiles={visibleArchivedFiles}
                      loading={visibleArchiveLoading}
                      onFilesChanged={handleArchivedFilesChanged}
                    />
                  ) : (
                    <div className="text-center py-12 text-muted-foreground">
                      <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">未选择项目</p>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Right: Classification Results + Analysis History */}
          <div className="md:col-span-6 lg:col-span-5 flex min-w-0 flex-col gap-4">
            {/* 归档一致性提示：每次归档后代码全量校验的结果 */}
            <ConsistencyPanel
              report={consistencyReport}
              dismissedKeys={dismissedFindingKeys}
              onDismiss={key =>
                setDismissedFindingKeys(current => {
                  const next = new Set(current);
                  next.add(key);
                  return next;
                })
              }
            />

            {/* Classification Results */}
            <Card className="flex min-w-0 flex-col overflow-hidden">
              <CardHeader className="shrink-0 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2 text-base md:text-lg">
                    <Brain className="h-5 w-5 text-violet-600" />
                    Agent 分类结果
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 rounded-full border bg-muted/30 px-3 py-1.5">
                      <Label
                        htmlFor="legacy-classification-toggle"
                        className="cursor-pointer text-xs font-normal text-muted-foreground"
                      >
                        显示规则阶段对照
                      </Label>
                      <Switch
                        id="legacy-classification-toggle"
                        checked={showLegacyClassification}
                        onCheckedChange={setShowLegacyClassification}
                        aria-label="运行并显示规则阶段对照"
                      />
                    </div>
                    <div className="flex items-center gap-2 rounded-full border bg-muted/30 px-3 py-1.5">
                      <Label
                        htmlFor="model-stage-decision-toggle"
                        className="cursor-pointer text-xs font-normal text-muted-foreground"
                      >
                        显示模型阶段判断
                      </Label>
                      <Switch
                        id="model-stage-decision-toggle"
                        checked={showModelStageDecision}
                        onCheckedChange={setShowModelStageDecision}
                        aria-label="运行并显示模型阶段判断影子结果"
                      />
                    </div>
                  </div>
                </div>
                <CardDescription>
                  {results.length > 0
                    ? `已处理 ${results.length} 个文件；${showLegacyClassification ? '后续上传将运行双轨对照' : '当前仅运行 Agent 分类'}${showModelStageDecision ? '，并附模型阶段判断影子结果' : ''}`
                    : showLegacyClassification
                      ? '上传后并列显示 Agent 与规则阶段判断'
                      : '规则对照已关闭，上传后直接显示 Agent 建议'}
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0 flex-1 px-3 pt-0">
                <div className="h-[320px] overflow-y-auto overflow-x-hidden pr-1 md:h-[400px] lg:h-[440px]">
                  {results.length > 0 ? (
                    <div className="w-full min-w-0 space-y-3 pb-2">
                      {results.map((result) => (
                        <ClassifyResultItem
                          key={result.clientId}
                          result={result}
                          showLegacyClassification={showLegacyClassification}
                          showModelStageDecision={showModelStageDecision}
                          onConfirmArchive={handleConfirmArchive}
                          onCancelArchive={handleCancelArchive}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">{isProcessing ? '正在分析文件…' : '暂无分类结果'}</p>
                      {!isProcessing && (
                        <p className="text-xs mt-1">先选择项目，再从中栏上传文件</p>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Analysis History */}
            <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <CardHeader className="pb-3 shrink-0">
                <CardTitle className="text-base md:text-lg flex items-center gap-2">
                  <History className="h-5 w-5 text-primary" />
                  分析记录
                </CardTitle>
                <CardDescription>
                  {selectedProject
                    ? `文件上传时间、原始名称与归档后名称`
                    : '请选择一个项目查看分析记录'}
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0 flex-1 px-3 pt-0">
                <div className="h-[240px] overflow-y-auto overflow-x-hidden pr-1 md:h-[300px] lg:h-[340px]">
                  {selectedProjectId ? (
                    <AnalysisHistoryPanel
                      records={visibleArchivedFiles}
                      loading={visibleArchiveLoading}
                    />
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">未选择项目</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <Dialog
        open={Boolean(renameProjectTarget)}
        onOpenChange={(open) => {
          if (!open && !renamingProject) {
            setRenameProjectTargetId(null);
            setRenameProjectName('');
            setRenameProjectDescription('');
            setRenameProjectError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑项目信息</DialogTitle>
            <DialogDescription>
              修改项目「{renameProjectTarget?.name}」的名称和描述。名称变化会同步到已归档文件。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="rename-project-name">项目名称</Label>
              <Input
                id="rename-project-name"
                value={renameProjectName}
                maxLength={255}
                autoFocus
                disabled={renamingProject}
                onChange={(event) => setRenameProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !renamingProject) {
                    event.preventDefault();
                    void confirmRenameProject();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="rename-project-description">项目描述（可选）</Label>
                <span className="text-xs text-muted-foreground">
                  {renameProjectDescription.length}/2000
                </span>
              </div>
              <Textarea
                id="rename-project-description"
                value={renameProjectDescription}
                maxLength={2000}
                rows={4}
                disabled={renamingProject}
                placeholder="简要描述项目背景、投资阶段或被投企业信息"
                className="min-h-24 resize-y"
                onChange={(event) => setRenameProjectDescription(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              S3 文件、文件夹结构和已归档文件名不会改变。
            </p>
            {renameProjectError && (
              <p className="text-sm text-destructive">{renameProjectError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={renamingProject}
              onClick={() => {
                setRenameProjectTargetId(null);
                setRenameProjectName('');
                setRenameProjectDescription('');
                setRenameProjectError(null);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={!renameProjectName.trim() || renamingProject}
              onClick={() => void confirmRenameProject()}
            >
              {renamingProject && <Loader2 className="h-4 w-4 animate-spin" />}
              {renamingProject ? '保存中…' : '保存新名称'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteProjectTarget)}
        onOpenChange={(open) => {
          if (!open && !deletingProject) {
            setDeleteProjectTargetId(null);
            setDeleteProjectError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除项目？</AlertDialogTitle>
            <AlertDialogDescription>
              你选择了项目「{deleteProjectTarget?.name}」。删除后将同时永久删除该项目中的
              {' '}<strong>{deleteProjectTarget?.fileCount || 0} 个归档文件</strong>
              、数据库记录和 S3 文件，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteProjectError && (
            <p className="text-sm text-destructive">{deleteProjectError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingProject}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deletingProject}
              onClick={(event) => {
                event.preventDefault();
                void confirmDeleteProject();
              }}
            >
              {deletingProject ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  删除中...
                </>
              ) : (
                '确认删除项目'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
