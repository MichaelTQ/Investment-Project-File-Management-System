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
  History, ArrowRightLeft, MoreHorizontal, Pencil, Eye
} from 'lucide-react';
import {
  FOLDER_STRUCTURE,
  SYSTEM_ARCHIVE_FOLDERS,
  type FolderNode,
  type ArchiveFolder,
  type Project,
  type ArchivedFile,
} from '@/lib/folder-structure';

interface ClassifyProcess {
  finalDecision: {
    method: 'agent' | 'stage' | 'none';
    explanation: string;
  };
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

// 冲突由模型比对时间线后给出，代码不再预设"什么算矛盾"，因此没有 kind 分类。
interface ConflictFinding {
  sourcePaths: string[];
  description: string;
  evidence: string[];
}

/**
 * 忽略某条冲突时用的键。**必须与服务端 minimal/pipeline.ts 的 conflictKey 一致**，
 * 否则前端标记为忽略的条目在后端过滤不掉，重建后又会冒出来。
 */
function conflictKey(finding: ConflictFinding): string {
  return `${[...finding.sourcePaths].sort().join('|')}::${finding.description}`;
}

interface ConsistencyReport {
  checkedCount: number;
  skippedCount: number;
  findings: ConflictFinding[];
  /** 冲突复核本身失败了（模型 ID 配错、超时等）。必须显示，否则会被误读成"没有矛盾"。 */
  reviewError?: string;
}

/** 一份已存文件抽取出来的事实。字段与后端 DocumentFacts 对齐。 */
interface StoredDocumentFacts {
  documentType: string;
  rawDocumentType: string;
  title: string;
  documentNumber: string | null;
  version: string | null;
  dates: Array<{ date: string | null; meaning: string; evidence: string }>;
  parties: Array<{ name: string; role: string }>;
  signStatus: string;
  transactionChanges: Array<{
    field: string;
    before: string | null;
    after: string | null;
    evidence: string;
  }>;
  explicitStageClues: string[];
  evidenceQuotes: string[];
  warnings: string[];
  sourceQuality: string;
}

interface StoredDocument {
  sourcePath: string;
  stage: string | null;
  facts: StoredDocumentFacts;
  updatedAt: number;
}

interface MinimalRebuildReport {
  documentCount: number;
  checkedCount: number;
  skippedCount: number;
  documents: StoredDocument[];
  timeline: Array<{
    date: string;
    sourcePath: string;
    stage: string | null;
    meaning: string;
    evidence: string;
  }>;
  findings: ConflictFinding[];
  dismissedCount: number;
  reviewError?: string;
}

interface MinimalDecisionResult {
  sourcePath: string;
  stage: string | null;
  folder: ArchiveFolder | null;
  reasoning: string;
  evidence: string[];
  contradictions: string[];
  requiresHumanReview: boolean;
  status: 'success' | 'fallback';
  error?: string;
}

interface ClassifyResult {
  clientId: string;
  fileName: string;
  sourcePath?: string;
  fileSize: number;
  targetFolder: ArchiveFolder | null;
  reasoning: string;
  contentPreview?: string;
  process: ClassifyProcess;
  classificationMode: 'minimal';
  businessStage?: string | null;
  documentType?: string;
  minimalDecision?: MinimalDecisionResult;
  minimalPending?: boolean;
  // 只声明界面用得到的字段；其余原样透传给归档接口。
  documentFacts?: { rawDocumentType?: string } & Record<string, unknown>;
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
  contextRebuildPending?: boolean;
}

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

// ============ 已提取的事实 ============
const SIGN_STATUS_LABELS: Record<string, string> = {
  unsigned: '未签署',
  signed: '已签字',
  sealed: '已盖章',
  signed_and_sealed: '签字并盖章',
  unknown: '无法判断',
};

const SOURCE_QUALITY_LABELS: Record<string, string> = {
  text: '文字层',
  visual_summary: '扫描件视觉识别',
  image: '图片',
  filename_only: '只读到文件名',
  mixed: '文字与图片混合',
};

/**
 * 一份文件抽取出来的事实。
 *
 * 这是系统对这份文件的全部认知——阶段判断、时间线、冲突复核都只看这些字段。
 * 归档结果不对时，先看这里：多半是事实就没读对，而不是判断逻辑有问题。
 */
function StoredFactsCard({ entry }: { entry: StoredDocument }) {
  const facts = entry.facts;
  const fileName =
    entry.sourcePath.split(/[/\\]/).pop() ?? entry.sourcePath;
  // 判据是有没有原文事实，不是模型自报的来源——它经常自报"只读到文件名"，
  // 却同时给出了日期和原文摘录。
  const hasContent =
    facts.dates.length > 0 ||
    facts.parties.length > 0 ||
    facts.transactionChanges.length > 0 ||
    facts.explicitStageClues.length > 0 ||
    facts.evidenceQuotes.length > 0;

  return (
    <details className="min-w-0 rounded-lg border border-emerald-200 bg-white/70">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-1.5 p-2.5">
        <span className="min-w-0 break-all text-[11px] font-medium text-emerald-950">
          {fileName}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {facts.documentType}
          {' · '}
          {entry.stage
            ? PROJECT_STAGE_LABELS[entry.stage] ?? entry.stage
            : '尚未归档'}
        </span>
      </summary>

      <div className="border-t border-emerald-100 px-2.5 pb-2.5 pt-2">
        <p className="break-words text-[10px] leading-4 text-muted-foreground">
          类型：{facts.documentType}
          {facts.rawDocumentType && facts.rawDocumentType !== '未知'
            ? `（原文表述：${facts.rawDocumentType}）`
            : ''}
          {' · '}
          {SIGN_STATUS_LABELS[facts.signStatus] ?? facts.signStatus}
          {' · '}
          来源：
          {SOURCE_QUALITY_LABELS[facts.sourceQuality] ?? facts.sourceQuality}
        </p>

        {!hasContent && (
          <p className="mt-1 text-[10px] leading-4 text-amber-700">
            没有读到任何原文事实，判断只能靠人工。
          </p>
        )}

        <dl className="mt-1.5 space-y-1 text-[10px] leading-4">
          <FactRow label="标题" values={[facts.title]} />
          <FactRow
            label="日期"
            values={facts.dates.map(
              item => `${item.date ?? '日期未知'}：${item.meaning}`
            )}
          />
          <FactRow
            label="字段变化"
            values={facts.transactionChanges.map(
              item =>
                `${item.field} ${item.before ?? '未写明'} → ${item.after ?? '未写明'}`
            )}
          />
          <FactRow
            label="主体"
            values={facts.parties.map(item => `${item.name}（${item.role}）`)}
          />
          <FactRow label="业务动作" values={facts.explicitStageClues} />
          <FactRow label="原文摘录" values={facts.evidenceQuotes} />
          <FactRow label="抽取提示" values={facts.warnings} muted />
        </dl>
      </div>
    </details>
  );
}

function FactRow({
  label,
  values,
  muted,
}: {
  label: string;
  values: string[];
  muted?: boolean;
}) {
  if (values.length === 0) return null;
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`break-words ${muted ? 'text-amber-700' : 'text-emerald-900'}`}>
        {values.map((value, index) => (
          <span key={`${value}-${index}`} className="block">
            {value}
          </span>
        ))}
      </dd>
    </div>
  );
}

// ============ 冲突提示 ============
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
    finding => !dismissedKeys.has(conflictKey(finding))
  );

  // 复核失败时必须出声：面板整个不渲染，看起来和"查过了，没问题"一模一样。
  if (report?.reviewError) {
    return (
      <Card className="border-red-300 bg-red-50/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm text-red-900">
            <AlertCircle className="h-4 w-4" />
            冲突复核没有跑成功，本次未做任何比对
          </CardTitle>
          <CardDescription className="break-words text-xs">
            {report.reviewError}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (visible.length === 0) return null;

  return (
    <Card className="border-amber-300 bg-amber-50/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm text-amber-900">
            <AlertCircle className="h-4 w-4" />
            发现 {visible.length} 处可能的矛盾
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
          本次比对了 {report?.checkedCount ?? 0} 份已归档文件
          {(report?.skippedCount ?? 0) > 0
            ? `，另有 ${report?.skippedCount} 份尚未归档已跳过`
            : ''}
          。以下由模型比对项目时间线后给出，仅供参考，不会自动改动归档结果。
        </CardDescription>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-2 pt-0">
          {visible.map(finding => {
            const key = conflictKey(finding);
            return (
              <div
                key={key}
                className="min-w-0 rounded-lg border border-amber-200 bg-white/70 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 break-all text-sm font-medium">
                    {finding.sourcePaths.length > 0
                      ? finding.sourcePaths.join('、')
                      : '项目整体'}
                  </p>
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
                  {finding.description}
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
              </div>
            );
          })}
          <p className="pt-1 text-[11px] leading-4 text-muted-foreground">
            这一步由模型完成，因此既可能漏报也可能误报。没有提示不代表其余文件一定
            归对。要调整位置请到下方档案区移动文件。
          </p>
        </CardContent>
      )}
    </Card>
  );
}

// ============ 分类结果项 ============
function ClassifyResultItem({
  result,
  onConfirmArchive,
  onCancelArchive,
}: {
  result: ClassifyResult;
  onConfirmArchive: (
    clientId: string,
    archiveTitle: string,
    folder: ArchiveFolder
  ) => void;
  onCancelArchive: (clientId: string) => void;
}) {
  const minimal = result.minimalDecision;
  const minimalFolder = minimal?.folder ?? null;
  const minimalRunning = Boolean(result.minimalPending && !minimal);
  const minimalNeedsReview =
    !minimalRunning && Boolean(minimal?.requiresHumanReview);
  const minimalSelectionValue = minimalFolder
    ? minimalFolder.folderId
    : '';
  const [archiveTitle, setArchiveTitle] = useState(
    result.fileName.replace(/\.[^.]+$/, '')
  );
  const [selectedFolderId, setSelectedFolderId] = useState(
    minimalSelectionValue
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (result.archiveStatus !== 'pending' || !minimalSelectionValue) return;
    setSelectedFolderId(current => current || minimalSelectionValue);
  }, [minimalSelectionValue, result.archiveStatus]);
  const selectedFolder = SYSTEM_ARCHIVE_FOLDERS.find(
    folder => folder.folderId === selectedFolderId
  );
  const isArchiving = result.archiveStatus === 'archiving';
  const needsConfirmation =
    result.requiresArchiveConfirmation &&
    !result.archived &&
    result.archiveStatus !== 'cancelled';

  return (
    <div
      className={`w-full min-w-0 overflow-hidden rounded-lg border bg-background ${
        minimalRunning
          ? 'border-l-4 border-l-sky-400'
          : result.minimalDecision?.folder
          ? 'border-l-4 border-l-violet-500'
          : 'border-l-4 border-l-amber-500'
      }`}
    >
      <div className="flex min-w-0 items-start gap-2.5 border-b bg-muted/20 p-3">
        <div className={`mt-0.5 shrink-0 rounded-md p-1.5 ${minimalRunning ? 'bg-sky-100' : minimalNeedsReview ? 'bg-amber-100' : 'bg-violet-100'}`}>
          {minimalRunning
            ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
            : minimalNeedsReview
            ? <AlertCircle className="h-4 w-4 text-amber-600" />
            : <Brain className="h-4 w-4 text-violet-600" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium leading-5">{result.fileName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{(result.fileSize / 1024).toFixed(1)} KB</span>
            {minimalRunning && (
              <>
                <span>·</span>
                <span>极简分类中</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-3 p-3">
        <div className="min-w-0 rounded-lg border border-violet-200 bg-violet-50/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-violet-900">
              <Brain className="h-3.5 w-3.5" />
              极简分类结果
            </p>
            <Badge
              variant="outline"
              className={minimalNeedsReview
                ? 'border-amber-300 bg-amber-50 text-[10px] text-amber-700'
                : 'border-green-300 bg-green-50 text-[10px] text-green-700'}
            >
              {minimalRunning ? '分析中' : minimalNeedsReview ? '需要复核' : '证据充分'}
            </Badge>
          </div>
          <p className="mt-2 break-words text-sm font-medium leading-5 text-violet-950">
            {minimalFolder
              ? minimalFolder.folderPath.join(' / ')
              : minimalRunning
                ? '正在抽取事实并判断'
                : minimal?.status === 'fallback'
                  ? '模型调用失败'
                  : '暂未形成唯一分类建议'}
          </p>
          <p className="mt-1 break-words text-[11px] leading-4 text-violet-700">
            业务阶段：{PROJECT_STAGE_LABELS[
              minimal?.stage ?? result.businessStage ?? 'unknown'
            ] ?? '待确认'}
            {' · '}
            文件类型：{result.documentType ?? '待识别'}
            {result.documentFacts?.rawDocumentType &&
              result.documentFacts.rawDocumentType !== '未知' &&
              `（原文表述：${result.documentFacts.rawDocumentType}）`}
          </p>
          <p className="mt-2 break-words text-xs leading-5 text-violet-800">
            {minimal?.reasoning ??
              minimal?.error ??
              (minimalRunning
                ? '正在抽取事实并交模型判断阶段。'
                : '未成功返回结果，请查看详情中的诊断信息。')}
          </p>
          {(minimal?.evidence.length ?? 0) > 0 && (
            <ul className="mt-2 space-y-1 border-t border-violet-200 pt-2 text-[11px] leading-4 text-green-800">
              {minimal?.evidence.slice(0, 2).map(item => (
                <li key={item} className="break-words">✓ {item}</li>
              ))}
            </ul>
          )}
          {(minimal?.contradictions.length ?? 0) > 0 && (
            <ul className="mt-2 space-y-1 border-t border-violet-200 pt-2 text-[11px] leading-4 text-amber-800">
              {minimal?.contradictions.slice(0, 2).map(item => (
                <li key={item} className="break-words">⚠ {item}</li>
              ))}
            </ul>
          )}
        </div>

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
              查看归档判断依据与文件内容摘要
            </DialogDescription>
          </DialogHeader>
          <ScrollArea type="always" className="min-h-0 flex-1 pr-5">
            <div className="space-y-4 pb-4">

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
  // 'abstract' 版阶段说明不含文件类型清单，用来验证清单是否在替模型答题。

  // 项目管理
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0);
  const [contextRefreshKey, setContextRefreshKey] = useState(0);
  const [consistencyReport, setConsistencyReport] =
    useState<ConsistencyReport | null>(null);
  const [minimalReport, setMinimalReport] =
    useState<MinimalRebuildReport | null>(null);
  const [minimalClearing, setMinimalClearing] = useState(false);
  // 用户忽略过的提示不再重复弹。切换项目时清空；持久化留待后续。
  const [dismissedFindingKeys, setDismissedFindingKeys] = useState<Set<string>>(
    () => new Set()
  );
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
      setConsistencyReport(null);
      setMinimalReport(null);
      return;
    }
    // 换项目时清掉忽略记录，避免不同项目之间互相压制提示。
    setDismissedFindingKeys(new Set());
    const controller = new AbortController();
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
        setConsistencyReport(data.consistency ?? null);
        setMinimalReport(data.minimal ?? null);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setProjectContextError(
          error instanceof Error ? error.message : '读取项目Context失败'
        );
      });
    return () => controller.abort();
  }, [selectedProjectId, contextRefreshKey]);

  const handleClearMinimalArchive = useCallback(async () => {
    if (!selectedProjectId) return;
    setMinimalClearing(true);
    try {
      const response = await fetch(
        `/api/project-context?projectId=${encodeURIComponent(selectedProjectId)}&scope=minimal`,
        { method: 'DELETE' }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || '清空极简事实表失败');
      }
      setMinimalReport(data.minimal ?? null);
    } catch (error) {
      setProjectContextError(
        error instanceof Error ? error.message : '清空极简事实表失败'
      );
    } finally {
      setMinimalClearing(false);
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
      const archiveReasoning =
        pendingResult.minimalDecision?.reasoning ?? pendingResult.reasoning;
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
              confidence: 0,
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
            formData.append('confidence', '0');
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
            };
        }
        return result;
      }));
      setArchiveRefreshKey(prev => prev + 1);
      setContextRefreshKey(prev => prev + 1);
      if (data.contextRebuildPending) {
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
            setConsistencyReport(rebuildData?.consistency ?? null);
            setMinimalReport(rebuildData?.minimal ?? null);
          })
          .catch(error => {
            setProjectContextError(
              error instanceof Error
                ? error.message
                : '归档成功，但后台 Context 更新失败'
            );
          });
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
      setResults(prev => [
        ...prev,
        {
          clientId,
          fileName: file.name,
          sourcePath: uploadedSourcePath,
          fileSize: file.size,
          targetFolder: null,
          confidence: 0,
          reasoning: '文件上传完成后将运行极简分类。',
          process: {
            finalDecision: {
              method: 'none',
              explanation: '正在抽取事实并运行极简分类。',
            },
          },
          classificationMode: 'minimal',
          requiresArchiveConfirmation: false,
          minimalPending: true,
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
            minimalPath: true,
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

        setResults(prev => {
          const completed: ClassifyResult = {
            ...result,
            clientId,
            sourcePath: uploadedSourcePath,
            requiresArchiveConfirmation: true,
            sourceStorageKey: uploadedStorageKey,
            sourceMimeType: file.type || 'application/octet-stream',
            sourceProjectId: selectedProjectId,
            archiveStatus: 'pending',
            minimalPending: false,
          };
          return prev.map(existing => {
            if (existing.clientId === clientId) return completed;
            return existing;
          });
        });

        if (result.contextRebuildPending && selectedProjectId) {
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
              setConsistencyReport(rebuildData?.consistency ?? null);
              setMinimalReport(rebuildData?.minimal ?? null);
            })
            .catch(error => {
              setProjectContextError(
                error instanceof Error
                  ? error.message
                  : '分类成功，但后台 Context 更新失败'
              );
            });
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
  }, [selectedProjectId, results]);

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

            {/* Project Context：时间线由代码拼出；冲突复核由模型在归档后跑 */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Zap className="h-5 w-5 text-emerald-600" />
                  项目 Context
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                {/* 极简链路的时间线：代码按日期排序拼出，不调用模型 */}
                {minimalReport && (
                  <div className="mt-3 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-900">
                        <Zap className="h-3.5 w-3.5" />
                        极简链路 Context
                      </p>
                      <Badge
                        variant="outline"
                        className="border-emerald-300 bg-white text-[10px] text-emerald-700"
                      >
                        时间线不调模型
                      </Badge>
                    </div>
                    <p className="text-[11px] leading-4 text-emerald-800">
                      依据 {minimalReport.documentCount} 份文件的事实；已归档{' '}
                      {minimalReport.checkedCount} 份
                      {minimalReport.skippedCount > 0
                        ? `，${minimalReport.skippedCount} 份尚未归档已跳过`
                        : ''}
                      ；事件 {minimalReport.timeline.length} 个
                      {minimalReport.findings.length > 0
                        ? `；上次复核发现 ${minimalReport.findings.length} 处矛盾`
                        : ''}
                    </p>

                    {/* 已存事实：系统从每份文件里究竟读到了什么，判断全部基于它 */}
                    {minimalReport.documents.length > 0 && (
                      <details className="group">
                        <summary className="cursor-pointer text-[11px] text-emerald-700 hover:underline">
                          查看各文件已提取的事实（{minimalReport.documents.length}）
                        </summary>
                        <div className="mt-1.5 space-y-2">
                          {minimalReport.documents.map(document => (
                            <StoredFactsCard
                              key={document.sourcePath}
                              entry={document}
                            />
                          ))}
                        </div>
                      </details>
                    )}

                    {minimalReport.timeline.length > 0 ? (
                      <details className="group">
                        <summary className="cursor-pointer text-[11px] text-emerald-700 hover:underline">
                          查看时间线（{minimalReport.timeline.length}）
                        </summary>
                        <ol className="mt-1.5 space-y-1.5 border-l border-emerald-200 pl-2.5">
                          {minimalReport.timeline.map((entry, index) => (
                            <li
                              key={`${entry.sourcePath}-${entry.date}-${index}`}
                              className="text-[11px] leading-4"
                            >
                              <span className="font-medium text-emerald-900">
                                {entry.date}
                              </span>
                              <span className="text-emerald-800">
                                {' '}
                                · {entry.meaning}
                              </span>
                              <p className="break-all text-muted-foreground">
                                {entry.sourcePath}
                                {entry.stage
                                  ? ` · ${PROJECT_STAGE_LABELS[entry.stage] ?? entry.stage}`
                                  : ' · 尚未归档'}
                              </p>
                            </li>
                          ))}
                        </ol>
                      </details>
                    ) : (
                      <p className="text-[11px] leading-4 text-muted-foreground">
                        还没有带日期的文件事实，时间线为空。
                      </p>
                    )}

                    <p className="border-t border-emerald-200 pt-1.5 text-[10px] leading-4 text-emerald-700">
                      时间线由代码按日期排序拼出，不需要模型综合，因此每次归档后都能
                      免费全量重建。
                    </p>
                    {minimalReport.documentCount > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-full text-[11px]"
                        disabled={!selectedProjectId || minimalClearing}
                        onClick={() => void handleClearMinimalArchive()}
                      >
                        {minimalClearing && (
                          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                        )}
                        清空极简事实表（{minimalReport.documentCount} 份）
                      </Button>
                    )}
                  </div>
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
                    极简分类结果
                  </CardTitle>
                </div>
                <CardDescription>
                  {results.length > 0
                    ? `已处理 ${results.length} 个文件；结果均需人工确认后归档`
                    : '上传后显示极简分类建议与一致性校验'}
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
