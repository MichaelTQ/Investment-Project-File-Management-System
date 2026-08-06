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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Folder, FolderOpen, FileText, Upload, CheckCircle2, AlertCircle,
  ChevronRight, ChevronDown, Loader2, Brain, Zap,
  Plus, Trash2, Download, Archive, Building2, Clock, X,
  History, ArrowRightLeft, MoreHorizontal, Pencil, Eye,
  Pause, Play, Square, FolderUp
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
  /** 确定性检查的结果：不调模型、不会误报，所以常开。 */
  ruleFindings?: ConflictFinding[];
  /** 系统建议人工深挖的文件。只标记，不自动执行。 */
  deepenSuggestions?: Array<{ sourcePath: string; reason: string }>;
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
  /** 批量流程里这份文件走到哪一步了。单份上传时不用。 */
  batchStage?: 'queued' | 'extracting' | 'extracted' | 'deciding' | 'aborted';
  /** 文件名归一到的规范词条，null 表示规范没覆盖。 */
  namingTerm?: string | null;
  /** unique 表示纯按命名规范定位、没读过内容。归档时据此记录来源。 */
  namingKind?: 'unique' | 'ambiguous' | 'unmatched';
}

/** 批量分析的进度。phase 决定进度条上显示的是哪一步。 */
interface BatchProgress {
  phase: 'naming' | 'uploading' | 'extracting' | 'deciding';
  total: number;
  done: number;
  currentFile: string;
  paused: boolean;
}

const BATCH_PHASE_LABELS: Record<BatchProgress['phase'], string> = {
  naming: '按文件名分流',
  uploading: '上传规范已覆盖的文件',
  extracting: '抽取事实',
  deciding: '判断归档阶段',
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
/**
 * 批量上传走文件夹，不走压缩包。
 *
 * 压缩包看着省事，实际三个坑：中文文件名在 zip 里没有统一编码（GBK/UTF-8 混着来，
 * 解出来经常是乱码）；要先整包传完才知道里面有几个文件，进度条和逐份暂停无从谈起；
 * 服务端还得引入解压依赖并防解压炸弹。文件夹这条路上，浏览器已经把目录结构摊平好了，
 * 而且原有链路本来就在用 webkitRelativePath 当 sourcePath，等于没有新增概念。
 */
type UploadFile = File & { archiveSourcePath?: string };

/** 文件在原始目录里的相对路径。拖进来的目录用自定义字段，选择目录用浏览器给的字段。 */
function sourcePathOf(file: File): string {
  return (
    (file as UploadFile).archiveSourcePath || file.webkitRelativePath || file.name
  );
}

/**
 * 把拖进来的东西摊平成文件列表。
 *
 * 拖文件夹时 dataTransfer.files 是空的——目录内容只能靠 webkitGetAsEntry 递归取。
 * 少了这段，用户拖一个文件夹进来会毫无反应，而这恰恰是最自然的手势。
 */
async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items)
    .map(item => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);

  // 浏览器不支持 entry API 时退回平铺文件，至少多选文件仍然可用。
  if (entries.length === 0) return Array.from(dataTransfer.files);

  const files: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>(resolve =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
      );
      if (!file) return;
      // webkitRelativePath 是只读的，改不了，把目录路径挂到自定义字段上。
      Object.defineProperty(file, 'archiveSourcePath', {
        value: `${prefix}${file.name}`,
        configurable: true,
      });
      files.push(file);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries 每次最多给 100 条，必须循环读到返回空数组为止，
    // 否则超过 100 个文件的目录会被静默截断。
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>(resolve =>
        reader.readEntries(resolve, () => resolve([]))
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };

  await Promise.all(entries.map(entry => walk(entry, '')));
  return files;
}

const UPLOAD_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.txt,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg';

/**
 * 操作系统塞在文件夹里的东西，一律不当作档案。
 *
 * 拖一个文件夹进来必然会带上 .DS_Store：它没有内容可读，却要完整走一遍上传、
 * OCR、抽事实、判阶段，白花钱和时间，还会作为"同项目其他文件"混进判断依据里。
 */
const IGNORED_UPLOAD_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.localized',
]);

function isIgnorableUpload(file: File): boolean {
  const name = file.name;
  if (IGNORED_UPLOAD_NAMES.has(name)) return true;
  // macOS 拷到非 HFS 卷时留下的资源分叉副本。
  if (name.startsWith('._')) return true;
  // 其余隐藏文件同样不是用户想归档的东西。
  if (name.startsWith('.')) return true;
  return false;
}

function UploadZone({ onFileUpload, disabled }: { onFileUpload: (files: File[]) => void; disabled: boolean }) {
  const [isDragging, setIsDragging] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={`relative border-2 border-dashed rounded-lg p-4 md:p-8 text-center transition-all ${disabled ? 'opacity-50 pointer-events-none' : ''} ${isDragging ? 'border-primary bg-primary/5 scale-[1.02]' : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        void collectDroppedFiles(e.dataTransfer).then(files => {
          if (files.length > 0) onFileUpload(files);
        });
      }}
    >
      <input
        type="file" multiple
        accept={UPLOAD_ACCEPT}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFileUpload(Array.from(e.target.files));
          }
          // 清空，否则连续选同一个文件夹不会再触发 change。
          e.target.value = '';
        }}
      />
      {/* 目录选择框需要单独一个 input：webkitdirectory 一旦打开就只能选目录。 */}
      <input
        ref={folderInputRef}
        type="file"
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFileUpload(Array.from(e.target.files));
          }
          e.target.value = '';
        }}
      />
      <div className="flex flex-col items-center gap-3">
        <div className={`p-4 rounded-full ${isDragging ? 'bg-primary/10' : 'bg-muted'}`}>
          <Upload className={`h-8 w-8 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <div>
          <p className="font-medium">拖拽文件或整个文件夹到此处</p>
          <p className="text-sm text-muted-foreground mt-1">支持 PDF、Word、Excel、PPT、TXT、图片（JPG/PNG/GIF/WebP/SVG）等格式</p>
          <p className="text-xs text-muted-foreground mt-1">多个文件会先全部抽取事实，再统一给出归档建议</p>
        </div>
        {/* 这个按钮浮在透明 input 之上，所以要自己挡住冒泡，否则会打开选文件对话框。 */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="relative z-10"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            folderInputRef.current?.click();
          }}
        >
          <FolderUp className="h-4 w-4 mr-1" />
          选择文件夹
        </Button>
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

// ============ 分类详情弹窗 ============
/**
 * 单份文件的分析详情。
 *
 * 单份上传的结果卡片和批量归档预览里的右键菜单共用同一个组件——两处排版必须一致，
 * 各写一份迟早会长歪。
 */
function ClassifyDetailsDialog({
  result,
  open,
  onOpenChange,
}: {
  result: ClassifyResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85dvh] max-h-[760px] max-w-3xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="break-all pr-6">分类详情：{result.fileName}</DialogTitle>
          <DialogDescription>
            查看归档判断依据与文件内容摘要
          </DialogDescription>
        </DialogHeader>
        <ScrollArea type="always" className="min-h-0 flex-1 pr-5">
          <div className="space-y-4 pb-4">

            {/* 极简分类结论：批量流程里结果卡片不展开，这里是唯一能看到判断理由的地方 */}
            {result.minimalDecision && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">归档判断</h4>
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="break-words text-sm">
                    建议归入：
                    <span className="font-medium">
                      {result.minimalDecision.folder
                        ? result.minimalDecision.folder.folderPath.join(' / ')
                        : '未能唯一确定'}
                    </span>
                  </p>
                  <p className="break-words text-xs leading-5 text-muted-foreground">
                    业务阶段：{PROJECT_STAGE_LABELS[
                      result.minimalDecision.stage ?? 'unknown'
                    ] ?? '待确认'}
                    {' · '}
                    文件类型：{result.documentType ?? '待识别'}
                    {result.documentFacts?.rawDocumentType &&
                      result.documentFacts.rawDocumentType !== '未知' &&
                      `（原文表述：${result.documentFacts.rawDocumentType}）`}
                  </p>
                  <p className="break-words text-xs leading-5">
                    {result.minimalDecision.reasoning ||
                      result.minimalDecision.error ||
                      '模型未给出理由。'}
                  </p>
                  {result.minimalDecision.evidence.length > 0 && (
                    <ul className="space-y-1 border-t pt-2 text-xs leading-5 text-green-800">
                      {result.minimalDecision.evidence.map(item => (
                        <li key={item} className="break-words">✓ {item}</li>
                      ))}
                    </ul>
                  )}
                  {result.minimalDecision.contradictions.length > 0 && (
                    <ul className="space-y-1 border-t pt-2 text-xs leading-5 text-amber-800">
                      {result.minimalDecision.contradictions.map(item => (
                        <li key={item} className="break-words">⚠ {item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {/* 各阶段耗时：数据一直在采集，之前从没渲染过，排查慢在哪只能靠猜 */}
            {(result.performance?.phases?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">
                  各阶段耗时（合计{' '}
                  {((result.performance?.totalDurationMs ?? 0) / 1000).toFixed(1)} 秒）
                </h4>
                <div className="space-y-1 rounded-lg border p-3">
                  {[...(result.performance?.phases ?? [])]
                    .sort((left, right) => right.durationMs - left.durationMs)
                    .map(phase => (
                      <div
                        key={`${phase.parentPhase ?? ''}-${phase.phase}`}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <span className="min-w-0 break-all font-mono text-muted-foreground">
                          {phase.parentPhase ? `${phase.parentPhase} / ` : ''}
                          {phase.phase}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {(phase.durationMs / 1000).toFixed(1)} 秒
                        </span>
                      </div>
                    ))}
                </div>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  子阶段耗时已包含在父阶段内，直接相加会重复计算。
                </p>
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

      <ClassifyDetailsDialog
        result={result}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
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

function ArchiveTreeItem({ node, level, onDownload, onDeleteNode, onMoveNode, onRenameNode, onExtractFacts, setCtxMenu }: {
  node: ArchiveTreeNode;
  level: number;
  onDownload: (fileId: string) => void;
  onExtractFacts: (node: ArchiveTreeNode) => void;
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
      // 归档之后仍然可以要求读内容：粗筛时按文件名归的位置，事后想核实随时能挖。
      { label: '提取事实并复核', icon: <Brain className="h-3.5 w-3.5 mr-2" />, action: () => onExtractFacts(node) },
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
              onExtractFacts={onExtractFacts}
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
  const [extractResult, setExtractResult] = useState<{
    fileName: string;
    status: 'running' | 'done' | 'error';
    message: string;
  } | null>(null);
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

  /**
   * 对已归档文件补抽事实。
   *
   * 粗筛时按文件名归位的文件没读过内容，事后想核实随时可以从这里挖。抽完会拿全项目
   * 的上下文重判一次阶段，但**只把结论说给人听，不自动挪文件**——归档位置是人的
   * 决定，读到新证据不构成替他改的理由。
   */
  const handleExtractArchivedFacts = async (node: ArchiveTreeNode) => {
    if (!node.file) return;
    const { id, originalName } = node.file;
    setExtractResult({
      fileName: originalName,
      status: 'running',
      message: '正在读取文件内容并抽取事实…',
    });
    try {
      const factsResponse = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'facts',
          archivedFileId: id,
          projectId,
          sourcePath: originalName,
        }),
      });
      const factsData = await factsResponse.json().catch(() => null);
      if (!factsResponse.ok) {
        throw new Error(
          [factsData?.error, factsData?.details].filter(Boolean).join('：') ||
            `抽取失败（HTTP ${factsResponse.status}）`
        );
      }

      const decideResponse = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'decide',
          archivedFileId: id,
          projectId,
          sourcePath: originalName,
        }),
      });
      const decided = await decideResponse.json().catch(() => null);
      const suggested: string[] | undefined =
        decided?.targetFolder?.folderPath?.slice(1);
      const currentPath = node.folderPath?.slice(1) ?? [];
      const differs =
        Array.isArray(suggested) &&
        suggested.join(' / ') !== currentPath.join(' / ');

      setExtractResult({
        fileName: originalName,
        status: 'done',
        message: !decideResponse.ok || !decided
          ? '事实已抽取并加入项目上下文，但重新判断阶段失败。'
          : differs
            ? `事实已加入项目上下文。按内容判断它更像属于「${suggested!.join(' / ')}」，当前归在「${currentPath.join(' / ')}」，请人工确认是否需要移动。`
            : '事实已加入项目上下文，按内容判断与当前归档位置一致。',
      });
    } catch (error) {
      setExtractResult({
        fileName: originalName,
        status: 'error',
        message: error instanceof Error ? error.message : '提取事实失败',
      });
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
      {extractResult && (
        <div
          className={`mb-2 rounded-md border p-2 text-xs ${
            extractResult.status === 'error'
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-violet-200 bg-violet-50 text-violet-800'
          }`}
        >
          <div className="flex items-start gap-1.5">
            {extractResult.status === 'running' ? (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : extractResult.status === 'error' ? (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="break-all font-medium">{extractResult.fileName}</p>
              <p className="mt-0.5 break-words leading-4">{extractResult.message}</p>
            </div>
            {extractResult.status !== 'running' && (
              <button
                className="shrink-0 opacity-60 hover:opacity-100"
                onClick={() => setExtractResult(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
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
            onExtractFacts={handleExtractArchivedFacts}
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

// ============ 批量归档预览 ============
/**
 * 批量分析完之后的归档预览。
 *
 * 18 份文件铺成 18 张结果卡片没法看，也看不出"这一批最后会长成什么样"。这里改成
 * 和「已归档文件」同一套树形显示：按最终归档位置分组，右键改位置或看详情，最后
 * 一键把整棵树并进档案。单份上传仍走原来的结果卡片，不进这个弹窗。
 */
interface BatchReviewFile {
  clientId: string;
  fileName: string;
  fileSize: number;
  /** 当前选定的归档位置。null 表示模型没定下来，必须人工选。 */
  folder: ArchiveFolder | null;
  /** 模型原本的建议，用来标出哪些被人工改过。 */
  suggestedFolderId: string | null;
  needsReview: boolean;
  /** 纯按文件名定位、没读过内容。界面要标出来，因为这一类最该被人扫一眼。 */
  byNamingRule: boolean;
  namingTerm?: string | null;
  archiveStatus?: ClassifyResult['archiveStatus'];
  archiveError?: string;
}

interface BatchTreeNode {
  name: string;
  key: string;
  children: BatchTreeNode[];
  files: BatchReviewFile[];
}

const UNPLACED_KEY = '__unplaced__';

/** 按归档位置把这一批文件组成一棵树。没有位置的单独归到一个待办分组。 */
function buildBatchTree(files: BatchReviewFile[]): BatchTreeNode[] {
  const roots: BatchTreeNode[] = [];

  const childNode = (siblings: BatchTreeNode[], name: string, key: string) => {
    const existing = siblings.find(node => node.key === key);
    if (existing) return existing;
    const created: BatchTreeNode = { name, key, children: [], files: [] };
    siblings.push(created);
    return created;
  };

  for (const file of files) {
    if (!file.folder) {
      childNode(roots, '未确定归档位置', UNPLACED_KEY).files.push(file);
      continue;
    }
    let siblings = roots;
    let node: BatchTreeNode | null = null;
    let keyPrefix = '';
    for (const segment of file.folder.folderPath) {
      keyPrefix = keyPrefix ? `${keyPrefix}/${segment}` : segment;
      node = childNode(siblings, segment, keyPrefix);
      siblings = node.children;
    }
    node?.files.push(file);
  }

  // 待办分组永远排最前面：有它就说明还不能一键归档。
  return roots.sort((left, right) =>
    left.key === UNPLACED_KEY ? -1 : right.key === UNPLACED_KEY ? 1 : 0
  );
}

function countBatchTreeFiles(node: BatchTreeNode): number {
  return (
    node.files.length +
    node.children.reduce((sum, child) => sum + countBatchTreeFiles(child), 0)
  );
}

interface BatchTreeActions {
  onShowDetails: (clientId: string) => void;
  onExtractFacts: (clientId: string) => void;
  onMoveFile: (file: BatchReviewFile) => void;
  extractingClientId: string | null;
}

function BatchTreeItem({
  node,
  level,
  actions,
}: {
  node: BatchTreeNode;
  level: number;
  actions: BatchTreeActions;
}) {
  const { extractingClientId } = actions;
  const [isOpen, setIsOpen] = useState(true);
  const fileCount = countBatchTreeFiles(node);
  const isUnplaced = node.key === UNPLACED_KEY;

  return (
    <div className="select-none">
      <div
        className="flex items-center gap-1 py-1 px-2 rounded cursor-pointer hover:bg-muted/50 transition-colors"
        style={{ paddingLeft: `${level * 12 + 6}px` }}
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        {isUnplaced
          ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          : isOpen
            ? <FolderOpen className="h-3.5 w-3.5 text-primary shrink-0" />
            : <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        <span className={`text-xs font-medium truncate ${isUnplaced ? 'text-amber-700' : ''}`}>
          {node.name}
        </span>
        {fileCount > 0 && (
          <Badge variant="outline" className="ml-auto text-[10px] px-1 py-0 shrink-0">
            {fileCount}
          </Badge>
        )}
      </div>
      {isOpen && (
        <div>
          {node.children.map(child => (
            <BatchTreeItem
              key={child.key}
              node={child}
              level={level + 1}
              actions={actions}
            />
          ))}
          {node.files.map(file => {
            const moved =
              file.folder !== null &&
              file.suggestedFolderId !== null &&
              file.folder.folderId !== file.suggestedFolderId;
            return (
              <ContextMenu key={file.clientId}>
              <ContextMenuTrigger asChild>
              <div
                className="flex items-center gap-1 py-1 px-2 rounded hover:bg-muted/50 transition-colors"
                style={{ paddingLeft: `${(level + 1) * 12 + 6}px` }}
                title={`${file.fileName}\n右键可查看分析详情或修改归档位置`}
              >
                {extractingClientId === file.clientId ? (
                  <Brain className="h-3.5 w-3.5 shrink-0 animate-pulse text-violet-600" />
                ) : file.archiveStatus === 'archiving' ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                ) : file.archiveStatus === 'archived' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
                ) : file.archiveStatus === 'error' ? (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
                <p className="min-w-0 flex-1 truncate text-xs">{file.fileName}</p>
                {moved && (
                  <Badge variant="outline" className="shrink-0 border-sky-300 bg-sky-50 px-1 py-0 text-[10px] text-sky-700">
                    已改
                  </Badge>
                )}
                {file.byNamingRule && !moved && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-slate-300 bg-slate-50 px-1 py-0 text-[10px] text-slate-600"
                    title={`按文件名对应规范里的「${file.namingTerm}」，未读取文件内容`}
                  >
                    按规范
                  </Badge>
                )}
                {file.needsReview && !moved && !file.byNamingRule && (
                  <Badge variant="outline" className="shrink-0 border-amber-300 bg-amber-50 px-1 py-0 text-[10px] text-amber-700">
                    待复核
                  </Badge>
                )}
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {(file.fileSize / 1024).toFixed(0)} KB
                </span>
              </div>
              </ContextMenuTrigger>
              {/* 用 Radix 的右键菜单而不是自己定位。
                  自己写的那版在弹窗里必然失灵：DialogContent 上有 translate 变换，
                  而带 transform 的祖先会让 position:fixed 相对该祖先定位而不是视口，
                  于是 left/top 用 clientX/clientY 算出来的位置整个跑到弹窗外面去，
                  看起来就像右键没反应。已归档文件树那份同样的代码能用，只是因为它
                  不在弹窗里。 */}
              <ContextMenuContent className="w-40">
                <ContextMenuItem onSelect={() => actions.onShowDetails(file.clientId)}>
                  <Eye className="h-3.5 w-3.5 mr-2" />
                  分析详情
                </ContextMenuItem>
                {/* 只对没读过内容的出现，已经抽过事实的再抽一次没有意义 */}
                {file.byNamingRule && (
                  <ContextMenuItem
                    onSelect={() => actions.onExtractFacts(file.clientId)}
                  >
                    <Brain className="h-3.5 w-3.5 mr-2" />
                    提取事实并复核
                  </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => actions.onMoveFile(file)}>
                  <ArrowRightLeft className="h-3.5 w-3.5 mr-2" />
                  修改归档位置
                </ContextMenuItem>
              </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 改归档位置。只允许选真实存在的阶段文件夹，避免造出归档接口不认识的 folderId。 */
function BatchMoveDialog({
  file,
  onConfirm,
  onCancel,
}: {
  file: BatchReviewFile;
  onConfirm: (folder: ArchiveFolder) => void;
  onCancel: () => void;
}) {
  const [selectedId, setSelectedId] = useState(file.folder?.folderId ?? '');
  const target = SYSTEM_ARCHIVE_FOLDERS.find(
    folder => folder.folderId === selectedId
  );

  return (
    <Dialog open={true} onOpenChange={() => onCancel()}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            修改归档位置
          </DialogTitle>
          <DialogDescription className="break-all">
            「<span className="font-medium text-foreground">{file.fileName}</span>」
            当前位置：{file.folder ? file.folder.folderPath.join(' / ') : '未确定'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-[300px] rounded-lg border p-2">
          <MoveFolderNode
            node={FOLDER_STRUCTURE}
            level={0}
            selectedId={selectedId}
            onSelect={id => setSelectedId(id)}
            path={[]}
          />
        </ScrollArea>
        {selectedId && !target && (
          <p className="text-xs text-amber-700">
            这一层只是分组，不能直接存放文件，请选择它下面的具体阶段。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button
            disabled={!target}
            onClick={() => { if (target) onConfirm(target); }}
          >
            确认修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchReviewDialog({
  open,
  onOpenChange,
  files,
  projectName,
  archiving,
  archiveProgress,
  onChangeFolder,
  onArchiveAll,
  onShowDetails,
  detailsResult,
  onCloseDetails,
  onExtractFacts,
  extractingClientId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: BatchReviewFile[];
  projectName: string;
  archiving: boolean;
  archiveProgress: { done: number; total: number } | null;
  onChangeFolder: (clientId: string, folder: ArchiveFolder) => void;
  onArchiveAll: () => void;
  onShowDetails: (clientId: string) => void;
  /** 右键点开的那一份。详情弹窗嵌在本弹窗内部，不能做成并列的第二个模态。 */
  detailsResult: ClassifyResult | null;
  onCloseDetails: () => void;
  /** 用户主动要求读这份文件的内容。批量默认不读按规范定位的那些。 */
  onExtractFacts: (clientId: string) => void;
  extractingClientId: string | null;
}) {
  const [moveTarget, setMoveTarget] = useState<BatchReviewFile | null>(null);

  const tree = useMemo(() => buildBatchTree(files), [files]);
  const unplacedCount = files.filter(file => !file.folder).length;
  const pendingCount = files.filter(
    file => file.archiveStatus !== 'archived'
  ).length;
  const failedCount = files.filter(
    file => file.archiveStatus === 'error'
  ).length;

  const treeActions: BatchTreeActions = {
    onShowDetails,
    onExtractFacts,
    onMoveFile: setMoveTarget,
    extractingClientId,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85dvh] max-h-[820px] max-w-2xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-primary" />
            批量归档预览
          </DialogTitle>
          <DialogDescription>
            {projectName ? `${projectName} — ` : ''}
            共 {files.length} 个文件，按建议的归档位置排列。右键单个文件可查看分析详情或修改位置。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-muted/20 p-2">
          {tree.map(node => (
            <BatchTreeItem
              key={node.key}
              node={node}
              level={0}
              actions={treeActions}
            />
          ))}
        </div>

        {unplacedCount > 0 && (
          <p className="shrink-0 text-xs text-amber-700">
            还有 {unplacedCount} 个文件没有归档位置，请右键逐个指定后再归档。
          </p>
        )}
        {failedCount > 0 && (
          <p className="shrink-0 text-xs text-destructive">
            有 {failedCount} 个文件归档失败，可重新点击一键归档只重试它们。
          </p>
        )}

        <DialogFooter className="shrink-0 gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {archiving && archiveProgress
              ? `正在归档 ${archiveProgress.done}/${archiveProgress.total}…`
              : `待归档 ${pendingCount} 个`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={archiving}
            >
              稍后处理
            </Button>
            <Button
              onClick={onArchiveAll}
              disabled={archiving || unplacedCount > 0 || pendingCount === 0}
            >
              {archiving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              一键归档（{pendingCount}）
            </Button>
          </div>
        </DialogFooter>

        {moveTarget && (
          <BatchMoveDialog
            file={moveTarget}
            onCancel={() => setMoveTarget(null)}
            onConfirm={folder => {
              onChangeFolder(moveTarget.clientId, folder);
              setMoveTarget(null);
            }}
          />
        )}

        {detailsResult && (
          <ClassifyDetailsDialog
            result={detailsResult}
            open={true}
            onOpenChange={open => { if (!open) onCloseDetails(); }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
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

  /**
   * 批量分析的进度与控制。
   *
   * 暂停和中断都必须用 ref 而不是 state：循环体是一个长跑的 async 函数，它闭包捕获
   * 的是点上传那一刻的 state 快照，中途 setState 它读不到，按钮会像失灵一样。
   */
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const pauseRef = useRef(false);
  const abortRef = useRef(false);
  const batchAbortControllerRef = useRef<AbortController | null>(null);

  /** 批量归档预览。为空表示这一轮不是批量，或者用户已经处理完了。 */
  const [batchReviewIds, setBatchReviewIds] = useState<string[] | null>(null);
  const [batchReviewOpen, setBatchReviewOpen] = useState(false);
  /** 人工改过的归档位置，按 clientId 记。没有条目的沿用模型建议。 */
  const [batchFolderOverrides, setBatchFolderOverrides] = useState<
    Record<string, ArchiveFolder>
  >({});
  const [batchArchiving, setBatchArchiving] = useState(false);
  const [batchArchiveProgress, setBatchArchiveProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const [batchDetailsClientId, setBatchDetailsClientId] = useState<string | null>(
    null
  );
  /** 正在按用户要求读内容的那一份。同一时刻只允许一个，避免并发写同一份事实。 */
  const [extractingClientId, setExtractingClientId] = useState<string | null>(
    null
  );

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

  /**
   * 把一份文件传进 S3 临时目录，返回 storageKey。
   * 分片上传中途失败时负责回收自己已经传上去的分片，不在桶里留半份文件。
   */
  const uploadToTemp = useCallback(async (
    file: File,
    projectId: string,
    signal?: AbortSignal
  ): Promise<string> => {
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk

    if (file.size <= CHUNK_SIZE) {
      const uploadResponse = await fetch('/api/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'x-project-id': projectId,
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
        signal,
      });
      const uploadData = await uploadResponse.json().catch(() => null);
      if (!uploadResponse.ok || !uploadData?.storageKey) {
        throw new Error(
          uploadData?.error || `上传到 S3 失败（HTTP ${uploadResponse.status}）`
        );
      }
      return String(uploadData.storageKey);
    }

    // 大文件：每个 2MB 分片立即存入 S3，最后无状态合并。
    const chunkUploadId = crypto.randomUUID();
    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const chunkKeys = new Array<string>(totalChunks);
      // 12.6MB 的文件切 7 片，3 并发要跑 3 批、6 并发只要 2 批，省约 2 秒。
      // 单片仍是 2MB，失败重传的代价不变。
      const CHUNK_UPLOAD_CONCURRENCY = 6;

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
          const chunkRes = await fetch('/api/uploads/chunk', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-upload-id': chunkUploadId,
              'x-chunk-index': String(index),
              'x-chunk-total': String(totalChunks),
              'x-project-id': projectId,
              'x-file-name': encodeURIComponent(file.name),
            },
            body: file.slice(start, end),
            signal,
          });
          const chunkData = await chunkRes.json().catch(() => null);
          if (!chunkRes.ok) {
            throw new Error(
              chunkData?.error ||
              `分片 ${index + 1}/${totalChunks} 上传失败（HTTP ${chunkRes.status}）`
            );
          }
          if (!chunkData?.chunkKey) {
            throw new Error(`分片 ${index + 1}/${totalChunks} 未返回 S3 地址`);
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
          projectId,
          fileName: encodeURIComponent(file.name),
          mimeType: file.type || 'application/octet-stream',
          chunkKeys,
        }),
        signal,
      });
      const completeData = await completeResponse.json().catch(() => null);
      if (!completeResponse.ok || !completeData?.storageKey) {
        throw new Error(
          completeData?.error ||
          `合并上传文件失败（HTTP ${completeResponse.status}）`
        );
      }
      return String(completeData.storageKey);
    } catch (error) {
      // 收掉已经传上去的分片。这次清理不能带 signal——中断时它自己会被一起取消，
      // 那就等于没清。
      await fetch('/api/uploads/chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'abort',
          uploadId: chunkUploadId,
          projectId,
        }),
      }).catch(() => null);
      throw error;
    }
  }, []);

  /**
   * 删掉临时文件，并让服务端连带忘掉这份文件的事实。
   *
   * 两件事必须一起做：只删临时文件的话，事实还留在项目档案里继续参与后续判断，
   * 用户以为撤销了其实没有。
   */
  const deleteTemp = useCallback((
    storageKey: string,
    projectId: string,
    sourcePath: string
  ) => {
    const params = new URLSearchParams({ storageKey, projectId, sourcePath });
    return fetch(`/api/uploads?${params}`, { method: 'DELETE' }).catch(
      () => null
    );
  }, []);

  const refreshAfterUpload = useCallback(() => {
    setArchiveRefreshKey(prev => prev + 1);
    // 刷新项目列表以更新文件计数
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => setProjects(data.projects || []))
      .catch(() => undefined);
  }, []);

  /** 单份上传：解析、抽事实、判阶段一次做完，和以前一样。 */
  const runSingleFile = useCallback(async (file: File, projectId: string) => {
    const clientId = crypto.randomUUID();
    const uploadedSourcePath = sourcePathOf(file);
    setResults([
      {
        clientId,
        fileName: file.name,
        sourcePath: uploadedSourcePath,
        fileSize: file.size,
        targetFolder: null,
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
    try {
      // 单份上传**不跳过任何步骤**，仍然读内容、抽事实、走完整链路。归一化在这里只用来
      // 多给判阶段的模型一句提示，让单份和批量里歧义分支拿到的上下文一致——否则同一份
      // 公司章程混在批量里判会比单独传更准，说不通。
      // 归一化和上传互不依赖，并行发出，正常情况下不增加等待时间；失败就当没有提示。
      const namingPromise = fetch('/api/naming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePaths: [uploadedSourcePath] }),
      })
        .then(async response => {
          if (!response.ok) return null;
          const data = await response.json().catch(() => null);
          const term = data?.results?.[0]?.term;
          return typeof term === 'string' ? term : null;
        })
        .catch(() => null);

      uploadedStorageKey = await uploadToTemp(file, projectId);
      const namingTerm = await namingPromise;

      const response = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storageKey: uploadedStorageKey,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          projectId,
          autoArchive: false,
          minimalPath: true,
          sourcePath: uploadedSourcePath,
          namingTerm,
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

      setResults(prev => prev.map(existing =>
        existing.clientId === clientId
          ? {
              ...result,
              clientId,
              sourcePath: uploadedSourcePath,
              requiresArchiveConfirmation: true,
              sourceStorageKey: uploadedStorageKey,
              sourceMimeType: file.type || 'application/octet-stream',
              sourceProjectId: projectId,
              archiveStatus: 'pending' as const,
              minimalPending: false,
            }
          : existing
      ));

      if (result.contextRebuildPending) {
        setProjectContextError(null);
        void fetch('/api/project-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId }),
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
      if (uploadedStorageKey) {
        void deleteTemp(uploadedStorageKey, projectId, uploadedSourcePath);
      }
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      setResults(prev => prev.map(existing =>
        existing.clientId === clientId
          ? {
              ...existing,
              targetFolder: null,
              minimalPending: false,
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
  }, [uploadToTemp, deleteTemp]);

  /**
   * 批量上传：先把整批的事实全抽出来，再逐份判阶段。
   *
   * 不能沿用单份流程一个个跑完——判阶段时模型要看"同项目其他文件的事实"，一份份来的话
   * 第一份判断时项目里空无一物、最后一份才看得到全貌，同一批文件的判断质量取决于它排在
   * 第几个。先抽后判，每份文件看到的上下文才是一样的。
   */
  const runBatchFlow = useCallback(async (files: File[], projectId: string) => {
    const controller = new AbortController();
    batchAbortControllerRef.current = controller;
    pauseRef.current = false;
    abortRef.current = false;

    // 每份文件在这一轮里的状态。放闭包里而不是 state：中断清理要读最新值，
    // 而长跑循环里读 state 拿到的是点上传那一刻的旧快照。
    const items = files.map(file => ({
      clientId: crypto.randomUUID(),
      file,
      sourcePath: sourcePathOf(file),
      storageKey: '',
      failed: false,
      /** 是否已产出待人工确认的建议。中断时只留下产出了建议的，其余一律清掉。 */
      suggested: false,
      /** 命名规范归一到的词条，null 表示规范没覆盖。 */
      namingTerm: null as string | null,
      /** unique 的按规范直接归档；ambiguous / unmatched 走事实链路。 */
      namingKind: 'unmatched' as 'unique' | 'ambiguous' | 'unmatched',
      namingStages: [] as string[],
    }));

    // 先把整批列出来，用户一眼能看到队列有多长、卡在哪一份。
    setResults(items.map(item => ({
      clientId: item.clientId,
      fileName: item.file.name,
      sourcePath: item.sourcePath,
      fileSize: item.file.size,
      targetFolder: null,
      reasoning: '排队中，等待抽取事实。',
      process: {
        finalDecision: { method: 'none' as const, explanation: '排队中。' },
      },
      classificationMode: 'minimal' as const,
      requiresArchiveConfirmation: false,
      minimalPending: true,
      batchStage: 'queued' as const,
    })));

    const patch = (clientId: string, changes: Partial<ClassifyResult>) =>
      setResults(prev =>
        prev.map(item =>
          item.clientId === clientId ? { ...item, ...changes } : item
        )
      );

    /** 暂停闸门。停在两份文件之间，不打断正在跑的这一份。 */
    const waitWhilePaused = async () => {
      while (pauseRef.current && !abortRef.current) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    };

    /**
     * 中断后的清理：凡是没产出建议的，临时文件和已抽的事实一起删掉。
     *
     * 事实必须删——它已经写进项目档案了，留着会继续作为"同项目其他文件"参与
     * 以后每一次判断，而用户从没见过这份文件的结果。
     */
    const cleanupUnfinished = async () => {
      await Promise.all(
        items
          .filter(item => item.storageKey && !item.suggested)
          .map(item => deleteTemp(item.storageKey, projectId, item.sourcePath))
      );
      const droppedIds = new Set(
        items.filter(item => !item.suggested).map(item => item.clientId)
      );
      // 没产出建议的行留着只会让用户以为还能确认。
      setResults(prev => prev.filter(item => !droppedIds.has(item.clientId)));
    };

    try {
      // ---------- 第 0 步：按文件名分流 ----------
      // 整批只调一次模型，把文件名归一到客户规范里的词条；词条到阶段的映射在服务端
      // 查表得出。归一失败不影响流程：全部按"未命中"处理，等于回到没有这一步之前。
      setBatchProgress({
        phase: 'naming',
        total: items.length,
        done: 0,
        currentFile: '',
        paused: false,
      });
      try {
        const namingResponse = await fetch('/api/naming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourcePaths: items.map(item => item.sourcePath),
          }),
          signal: controller.signal,
        });
        const namingData = await namingResponse.json().catch(() => null);
        if (namingResponse.ok && Array.isArray(namingData?.results)) {
          namingData.results.forEach(
            (
              result: { kind?: string; term?: string | null; stages?: string[] },
              index: number
            ) => {
              const item = items[index];
              if (!item) return;
              item.namingTerm = result.term ?? null;
              item.namingStages = result.stages ?? [];
              item.namingKind =
                result.kind === 'unique' || result.kind === 'ambiguous'
                  ? result.kind
                  : 'unmatched';
            }
          );
        }
      } catch (error) {
        if (!abortRef.current) console.warn('文件名分流失败，全部走事实链路', error);
      }

      // ---------- 唯一命中：只上传，不读内容 ----------
      // 规范已经给出答案，粗筛阶段没必要为它花 OCR 和模型调用。它们照样进归档预览的
      // 文件树，跟其余文件一起等一键归档；只是归档时来源记为"命名规范"，并在项目档案
      // 里标成"只读到文件名"，随时可以人工要求补抽事实。
      const namedItems = items.filter(item => item.namingKind === 'unique');
      if (namedItems.length > 0 && !abortRef.current) {
        setBatchProgress({
          phase: 'uploading',
          total: namedItems.length,
          done: 0,
          currentFile: '',
          paused: false,
        });
        for (const [index, item] of namedItems.entries()) {
          await waitWhilePaused();
          if (abortRef.current) break;
          setBatchProgress(prev =>
            prev ? { ...prev, done: index, currentFile: item.file.name } : prev
          );
          const folder = SYSTEM_ARCHIVE_FOLDERS.find(
            candidate => candidate.businessStage === item.namingStages[0]
          );
          try {
            item.storageKey = await uploadToTemp(
              item.file,
              projectId,
              controller.signal
            );
            if (!folder) throw new Error('命名规范给出的阶段没有对应的归档文件夹');
            item.suggested = true;
            patch(item.clientId, {
              batchStage: undefined,
              targetFolder: folder,
              namingTerm: item.namingTerm,
              namingKind: 'unique',
              requiresArchiveConfirmation: true,
              sourceStorageKey: item.storageKey,
              sourceMimeType: item.file.type || 'application/octet-stream',
              sourceProjectId: projectId,
              archiveStatus: 'pending',
              minimalPending: false,
              reasoning: `文件名对应归档规范里的「${item.namingTerm}」，规范只把它列在这一个阶段，未读取文件内容。`,
              process: {
                finalDecision: {
                  method: 'stage' as const,
                  explanation: `按命名规范归入“${folder.folderPath.slice(1).join(' / ')}”`,
                },
              },
            });
          } catch (error) {
            if (abortRef.current) break;
            item.failed = true;
            const message = error instanceof Error ? error.message : '未知错误';
            if (item.storageKey) {
              void deleteTemp(item.storageKey, projectId, item.sourcePath);
              item.storageKey = '';
            }
            patch(item.clientId, {
              batchStage: undefined,
              minimalPending: false,
              reasoning: `上传失败：${message}`,
              process: {
                finalDecision: {
                  method: 'none' as const,
                  explanation: `上传失败：${message}`,
                },
              },
            });
          }
          setBatchProgress(prev =>
            prev ? { ...prev, done: index + 1 } : prev
          );
        }
      }

      // ---------- 第一阶段：抽取其余文件的事实 ----------
      const needsFacts = items.filter(item => item.namingKind !== 'unique');
      setBatchProgress({
        phase: 'extracting',
        total: needsFacts.length,
        done: 0,
        currentFile: '',
        paused: false,
      });

      for (const [index, item] of needsFacts.entries()) {
        await waitWhilePaused();
        if (abortRef.current) break;

        setBatchProgress({
          phase: 'extracting',
          total: needsFacts.length,
          done: index,
          currentFile: item.file.name,
          paused: false,
        });
        // 抽事实占整体进度的前一半。
        setProcessingProgress(Math.round((index / needsFacts.length) * 50));
        patch(item.clientId, {
          batchStage: 'extracting',
          reasoning: '正在读取文件并抽取事实…',
        });

        try {
          item.storageKey = await uploadToTemp(
            item.file,
            projectId,
            controller.signal
          );
          const response = await fetch('/api/classify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'facts',
              storageKey: item.storageKey,
              fileName: item.file.name,
              fileSize: item.file.size,
              mimeType: item.file.type || 'application/octet-stream',
              projectId,
              sourcePath: item.sourcePath,
            }),
            signal: controller.signal,
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            const serverMessage = [data?.error, data?.details]
              .filter(Boolean)
              .join('：');
            throw new Error(
              serverMessage || `请求失败（HTTP ${response.status}）`
            );
          }
          patch(item.clientId, {
            batchStage: 'extracted',
            documentFacts: data?.documentFacts,
            documentType: data?.documentType,
            contentPreview: data?.contentPreview,
            performance: data?.performance,
            reasoning: '事实已抽取，等整批抽完后统一给出归档建议。',
          });
        } catch (error) {
          if (abortRef.current) break;
          item.failed = true;
          const message = error instanceof Error ? error.message : '未知错误';
          // 这一份没抽成，临时文件立刻收掉，不用等到整批结束。
          if (item.storageKey) {
            void deleteTemp(item.storageKey, projectId, item.sourcePath);
            item.storageKey = '';
          }
          patch(item.clientId, {
            batchStage: undefined,
            minimalPending: false,
            reasoning: `抽取事实失败：${message}`,
            process: {
              finalDecision: {
                method: 'none' as const,
                explanation: `抽取事实失败：${message}`,
              },
            },
          });
        }

        setBatchProgress(prev =>
          prev ? { ...prev, done: index + 1 } : prev
        );
        setProcessingProgress(
          Math.round(((index + 1) / needsFacts.length) * 50)
        );
      }

      // ---------- 第二阶段：事实齐了，判阶段 ----------
      const ready = needsFacts.filter(item => item.storageKey && !item.failed);
      // 先试整批一次判完：逐份判断每次都要重发同项目其他文件的事实和整条时间线，
      // 17 份就是 17 次调用各驮 17 份上下文。一次判完把输入压回原来的几分之一，
      // 而且模型能同时看到所有文件，本来就更适合"两份放一起才分得清"的情况。
      // 失败或漏判的退回逐份判断，兜底必须留着。
      let pendingDecide = ready;
      if (!abortRef.current && ready.length > 1) {
        setBatchProgress({
          phase: 'deciding',
          total: ready.length,
          done: 0,
          currentFile: `整批一次判断（${ready.length} 份）`,
          paused: pauseRef.current,
        });
        try {
          const response = await fetch('/api/decide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              sourcePaths: ready.map(item => item.sourcePath),
              namingTerms: ready.map(item => item.namingTerm),
            }),
            signal: controller.signal,
          });
          const data = await response.json().catch(() => null);
          if (response.ok && Array.isArray(data?.results)) {
            const decidedPaths = new Set<string>();
            data.results.forEach(
              (
                entry: { sourcePath?: string; decision?: MinimalDecisionResult | null },
                index: number
              ) => {
                const item = ready[index];
                if (!item || !entry?.decision) return;
                const decision = entry.decision;
                decidedPaths.add(item.sourcePath);
                item.suggested = true;
                patch(item.clientId, {
                  targetFolder: decision.folder ?? null,
                  businessStage: decision.stage,
                  minimalDecision: decision,
                  reasoning: decision.reasoning,
                  documentType: item.namingTerm ?? undefined,
                  namingTerm: item.namingTerm,
                  namingKind: item.namingKind,
                  requiresArchiveConfirmation: true,
                  sourceStorageKey: item.storageKey,
                  sourceMimeType: item.file.type || 'application/octet-stream',
                  sourceProjectId: projectId,
                  archiveStatus: 'pending',
                  minimalPending: false,
                  batchStage: undefined,
                  process: {
                    finalDecision: decision.folder
                      ? {
                          method: 'stage' as const,
                          explanation: `整批判断建议归入“${decision.folder.folderPath.slice(1).join(' / ')}”`,
                        }
                      : {
                          method: 'none' as const,
                          explanation: '整批判断未能确定阶段，已退回逐份判断。',
                        },
                  },
                });
              }
            );
            // 模型漏掉的那几份退回逐份判断，不能让它们静默变成"未确定"。
            pendingDecide = ready.filter(
              item => !decidedPaths.has(item.sourcePath)
            );
          }
        } catch (error) {
          if (!abortRef.current) {
            console.warn('整批判断失败，退回逐份判断', error);
          }
        }
      }

      if (!abortRef.current && pendingDecide.length > 0) {
        setBatchProgress({
          phase: 'deciding',
          total: pendingDecide.length,
          done: 0,
          currentFile: '',
          paused: pauseRef.current,
        });

        for (const [index, item] of pendingDecide.entries()) {
          await waitWhilePaused();
          if (abortRef.current) break;

          setBatchProgress({
            phase: 'deciding',
            total: pendingDecide.length,
            done: index,
            currentFile: item.file.name,
            paused: false,
          });
          setProcessingProgress(
            50 + Math.round((index / pendingDecide.length) * 50)
          );
          patch(item.clientId, {
            batchStage: 'deciding',
            reasoning: '正在判断归档阶段…',
          });

          try {
            const response = await fetch('/api/classify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mode: 'decide',
                storageKey: item.storageKey,
                fileName: item.file.name,
                fileSize: item.file.size,
                mimeType: item.file.type || 'application/octet-stream',
                projectId,
                sourcePath: item.sourcePath,
                // 歧义词条给模型当提示用；服务端会自己查表得出候选阶段，
                // 前端只透传词条，不参与"词条属于哪个阶段"的判断。
                namingTerm: item.namingTerm,
              }),
              signal: controller.signal,
            });
            const result = await response.json().catch(() => null);
            if (!response.ok || !result) {
              const serverMessage = [result?.error, result?.details]
                .filter(Boolean)
                .join('：');
              throw new Error(
                serverMessage || `请求失败（HTTP ${response.status}）`
              );
            }

            item.suggested = true;
            patch(item.clientId, {
              ...result,
              clientId: item.clientId,
              sourcePath: item.sourcePath,
              namingTerm: item.namingTerm,
              namingKind: item.namingKind,
              requiresArchiveConfirmation: true,
              sourceStorageKey: item.storageKey,
              sourceMimeType: item.file.type || 'application/octet-stream',
              sourceProjectId: projectId,
              archiveStatus: 'pending' as const,
              minimalPending: false,
              batchStage: undefined,
            });
          } catch (error) {
            if (abortRef.current) break;
            const message = error instanceof Error ? error.message : '未知错误';
            patch(item.clientId, {
              batchStage: undefined,
              minimalPending: false,
              reasoning: `判断阶段失败：${message}`,
              process: {
                finalDecision: {
                  method: 'none' as const,
                  explanation: `判断阶段失败：${message}`,
                },
              },
            });
          }

          setBatchProgress(prev =>
            prev ? { ...prev, done: index + 1 } : prev
          );
          setProcessingProgress(
            50 + Math.round(((index + 1) / pendingDecide.length) * 50)
          );
        }
      }

      if (abortRef.current) await cleanupUnfinished();

      // 有结果就把整批摊成文件树给用户过目。18 张结果卡片没法看，也看不出
      // "这一批最后会长成什么样"。
      const reviewable = items.filter(item => item.suggested);
      if (reviewable.length > 0) {
        setBatchReviewIds(reviewable.map(item => item.clientId));
        setBatchReviewOpen(true);
      }
    } finally {
      // 控制器不置空的话，这一批的 AbortController 会一直被 ref 攥着，
      // 连同它内部登记的监听器一起留到下一批。
      batchAbortControllerRef.current = null;
      pauseRef.current = false;
      abortRef.current = false;
      setBatchProgress(null);
      setProcessingProgress(100);
      setIsProcessing(false);
      refreshAfterUpload();
    }
  }, [uploadToTemp, deleteTemp, refreshAfterUpload]);

  const handleFileUpload = useCallback(async (files: File[]) => {
    if (!selectedProjectId) {
      alert('请先选择或创建一个项目');
      return;
    }
    if (results.some(result => result.requiresArchiveConfirmation)) {
      alert('请先确认或取消当前待归档文件，再上传新一批文件');
      return;
    }
    if (files.length === 0) return;

    // 拖文件夹必然带上 .DS_Store 这类系统文件。它们没有内容可读，却要完整走一遍
    // 上传、OCR、抽事实、判阶段，白花钱和时间，还会混进"同项目其他文件"里。
    const uploadable = files.filter(file => !isIgnorableUpload(file));
    const skippedCount = files.length - uploadable.length;
    if (uploadable.length === 0) {
      alert(
        skippedCount > 0
          ? `选中的 ${skippedCount} 个文件都是系统文件（如 .DS_Store），没有可归档的内容`
          : '没有可上传的文件'
      );
      return;
    }
    if (skippedCount > 0) {
      console.log(`[upload] 跳过 ${skippedCount} 个系统文件`);
    }

    setIsProcessing(true);
    setProcessingProgress(0);
    setResults([]);
    setBatchReviewIds(null);
    setBatchFolderOverrides({});

    // 单份文件没有"同批其他文件"可等，拆两阶段只会多一次往返。
    if (uploadable.length === 1) {
      try {
        await runSingleFile(uploadable[0], selectedProjectId);
      } finally {
        setProcessingProgress(100);
        setIsProcessing(false);
        refreshAfterUpload();
      }
      return;
    }

    await runBatchFlow(uploadable, selectedProjectId);
  }, [
    selectedProjectId,
    results,
    runSingleFile,
    runBatchFlow,
    refreshAfterUpload,
  ]);

  /** 暂停：跑完当前这一份就停在原地，不取消已经发出去的请求。 */
  const handleTogglePause = useCallback(() => {
    pauseRef.current = !pauseRef.current;
    setBatchProgress(prev =>
      prev ? { ...prev, paused: pauseRef.current } : prev
    );
  }, []);

  /** 中断：连同正在跑的这一份一起停掉，随后清理没产出结果的文件。 */
  const handleAbortBatch = useCallback(() => {
    abortRef.current = true;
    pauseRef.current = false;
    batchAbortControllerRef.current?.abort();
    setBatchProgress(prev => (prev ? { ...prev, paused: false } : prev));
  }, []);

  /** 批量预览里每份文件的当前状态。人工改过位置的以人工为准。 */
  const batchReviewFiles = useMemo<BatchReviewFile[]>(() => {
    if (!batchReviewIds) return [];
    const byId = new Map(results.map(result => [result.clientId, result]));
    return batchReviewIds.flatMap(clientId => {
      const result = byId.get(clientId);
      if (!result) return [];
      const suggested =
        result.minimalDecision?.folder ?? result.targetFolder ?? null;
      return [{
        clientId,
        fileName: result.fileName,
        fileSize: result.fileSize,
        folder: batchFolderOverrides[clientId] ?? suggested,
        suggestedFolderId: suggested?.folderId ?? null,
        needsReview: Boolean(result.minimalDecision?.requiresHumanReview),
        byNamingRule: result.namingKind === 'unique',
        namingTerm: result.namingTerm,
        archiveStatus: result.archiveStatus,
        archiveError: result.archiveError,
      }];
    });
  }, [batchReviewIds, results, batchFolderOverrides]);

  /**
   * 一键归档：把预览里的整棵树并进已归档文件。
   *
   * 逐份调归档接口，但**只在全部结束后重建一次项目上下文**——重建要跑冲突复核，
   * 每份一次的话 18 个文件就是 18 次模型调用，光等待就不可接受。
   */
  const handleBatchArchiveAll = useCallback(async () => {
    const sourceById = new Map(results.map(result => [result.clientId, result]));
    const pending = batchReviewFiles.filter(
      entry => entry.folder && entry.archiveStatus !== 'archived'
    );
    if (pending.length === 0) return;

    setBatchArchiving(true);
    setBatchArchiveProgress({ done: 0, total: pending.length });
    let archivedAny = false;
    let lastProjectId = '';

    try {
      for (const [index, entry] of pending.entries()) {
        const source = sourceById.get(entry.clientId);
        const folder = entry.folder;
        if (!source || !folder) continue;
        if (!source.sourceStorageKey || !source.sourceProjectId) {
          setResults(prev => prev.map(result =>
            result.clientId === entry.clientId
              ? {
                  ...result,
                  archiveStatus: 'error' as const,
                  archiveError: '待归档文件信息已丢失，请重新上传',
                }
              : result
          ));
          setBatchArchiveProgress({ done: index + 1, total: pending.length });
          continue;
        }
        lastProjectId = source.sourceProjectId;

        setResults(prev => prev.map(result =>
          result.clientId === entry.clientId
            ? { ...result, archiveStatus: 'archiving' as const, archiveError: undefined }
            : result
        ));

        try {
          const response = await fetch('/api/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              storageKey: source.sourceStorageKey,
              originalName: source.fileName,
              fileSize: source.fileSize,
              mimeType: source.sourceMimeType,
              projectId: source.sourceProjectId,
              folderId: folder.folderId,
              archiveTitle:
                source.suggestedArchiveTitle ||
                source.fileName.replace(/\.[^.]+$/, ''),
              confidence: 0,
              reasoning:
                source.minimalDecision?.reasoning ?? source.reasoning,
              sourcePath: source.sourcePath || source.fileName,
              documentFacts: source.documentFacts,
              // 人改过位置的算人工确认；原样采纳命名规范建议的记成规范来源。
              // 冲突复核会区别对待这两者：对前者给面子，对后者主动质疑。
              stageSource:
                source.namingKind === 'unique' &&
                folder.folderId === source.targetFolder?.folderId
                  ? 'naming_rule'
                  : 'human',
            }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.archived) {
            throw new Error(data?.error || '归档失败，请重试');
          }
          archivedAny = true;
          setResults(prev => prev.map(result =>
            result.clientId === entry.clientId
              ? {
                  ...result,
                  targetFolder: folder,
                  requiresArchiveConfirmation: false,
                  archiveStatus: 'archived' as const,
                  archiveError: undefined,
                  sourceFile: undefined,
                  sourceStorageKey: undefined,
                  archived: data.archived,
                }
              : result
          ));
        } catch (error) {
          const message = error instanceof Error ? error.message : '归档失败';
          setResults(prev => prev.map(result =>
            result.clientId === entry.clientId
              ? { ...result, archiveStatus: 'error' as const, archiveError: message }
              : result
          ));
        }

        setBatchArchiveProgress({ done: index + 1, total: pending.length });
      }
    } finally {
      setBatchArchiving(false);
      setBatchArchiveProgress(null);
    }

    if (archivedAny) {
      setArchiveRefreshKey(prev => prev + 1);
      setContextRefreshKey(prev => prev + 1);
      fetch('/api/projects')
        .then(response => response.json())
        .then(data => setProjects(data.projects || []))
        .catch(() => undefined);

      if (lastProjectId) {
        setProjectContextError(null);
        void fetch('/api/project-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: lastProjectId }),
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
    }
  }, [results, batchReviewFiles]);

  /**
   * 用户主动要求读某份文件的内容。
   *
   * 批量流程默认不读按命名规范定位的文件——那是粗筛提速的来源。但人扫过文件树时
   * 可能对某一份不放心，这里给他一个随时加深的入口：抽事实、重新判一次阶段，
   * 结果只作提示，**不自动挪动文件**。
   *
   * 这个入口也是将来 agent 回补循环要用的同一条路，只是调度者从人换成程序。
   */
  const handleExtractFacts = useCallback(async (clientId: string) => {
    const target = results.find(result => result.clientId === clientId);
    if (!target?.sourceStorageKey || !target.sourceProjectId) return;

    setExtractingClientId(clientId);
    try {
      const factsResponse = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'facts',
          storageKey: target.sourceStorageKey,
          fileName: target.fileName,
          fileSize: target.fileSize,
          mimeType: target.sourceMimeType,
          projectId: target.sourceProjectId,
          sourcePath: target.sourcePath || target.fileName,
        }),
      });
      const factsData = await factsResponse.json().catch(() => null);
      if (!factsResponse.ok) {
        throw new Error(
          [factsData?.error, factsData?.details].filter(Boolean).join('：') ||
            `抽取失败（HTTP ${factsResponse.status}）`
        );
      }

      const decideResponse = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'decide',
          storageKey: target.sourceStorageKey,
          fileName: target.fileName,
          fileSize: target.fileSize,
          mimeType: target.sourceMimeType,
          projectId: target.sourceProjectId,
          sourcePath: target.sourcePath || target.fileName,
          namingTerm: target.namingTerm,
        }),
      });
      const decided = await decideResponse.json().catch(() => null);
      if (!decideResponse.ok || !decided) {
        throw new Error(decided?.error || '判断阶段失败');
      }

      setResults(prev => prev.map(result =>
        result.clientId === clientId
          ? {
              ...result,
              documentFacts: factsData?.documentFacts,
              documentType: factsData?.documentType,
              contentPreview: factsData?.contentPreview,
              minimalDecision: decided.minimalDecision,
              reasoning: decided.reasoning ?? result.reasoning,
              // 位置不自动改：读完内容只是多了一条依据，挪不挪由人决定。
              // 建议的位置在详情里看得到，和当前位置不一致时预览树会标出来。
              namingKind: 'ambiguous' as const,
            }
          : result
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      setResults(prev => prev.map(result =>
        result.clientId === clientId
          ? { ...result, reasoning: `提取事实失败：${message}` }
          : result
      ));
    } finally {
      setExtractingClientId(null);
    }
  }, [results]);

  /**
   * 放弃整批。
   *
   * 必须有这个出口：没归档的结果会一直占着"待确认"，而待确认状态会锁住上传区。
   * 关掉预览之后如果没有别的入口，用户就卡死了——只能刷新页面，而刷新会把临时文件
   * 和事实一起留成孤儿。
   */
  const handleDiscardBatch = useCallback(() => {
    const ids = new Set(batchReviewIds ?? []);
    for (const target of results) {
      if (!ids.has(target.clientId)) continue;
      if (target.sourceStorageKey && target.sourceProjectId) {
        void deleteTemp(
          target.sourceStorageKey,
          target.sourceProjectId,
          target.sourcePath || target.fileName
        );
      }
    }
    setResults(prev => prev.filter(result => !ids.has(result.clientId)));
    setBatchReviewIds(null);
    setBatchReviewOpen(false);
    setBatchFolderOverrides({});
    setBatchDetailsClientId(null);
  }, [batchReviewIds, results, deleteTemp]);

  // 全部归档完就收掉预览，别让用户对着一棵已经并进档案的树发呆。
  // 同时清掉批次标记，右侧面板回到结果卡片列表，上传区也随之解锁。
  useEffect(() => {
    if (batchArchiving || batchReviewFiles.length === 0) return;
    if (batchReviewFiles.every(entry => entry.archiveStatus === 'archived')) {
      setBatchReviewOpen(false);
      setBatchReviewIds(null);
      setBatchFolderOverrides({});
      setBatchDetailsClientId(null);
    }
  }, [batchArchiving, batchReviewFiles]);

  // 组件卸载时把还在跑的批次掐掉，否则它会继续 setState 到已经没了的组件上。
  useEffect(() => () => {
    abortRef.current = true;
    batchAbortControllerRef.current?.abort();
    batchAbortControllerRef.current = null;
  }, []);

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

                    {/* 确定性检查：纯比对得出，不调模型也不会误报，所以直接铺开显示，
                        不像模型复核那样折叠起来 */}
                    {(minimalReport.ruleFindings?.length ?? 0) > 0 && (
                      <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2">
                        <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-900">
                          <AlertCircle className="h-3.5 w-3.5" />
                          数值比对发现 {minimalReport.ruleFindings!.length} 处时点对不上
                        </p>
                        {minimalReport.ruleFindings!.map((finding, index) => (
                          <div key={index} className="text-[11px] leading-4 text-amber-800">
                            <p className="break-words">{finding.description}</p>
                            {finding.evidence.map(item => (
                              <p key={item} className="break-words pl-3 text-amber-700">
                                · {item}
                              </p>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 建议深挖：系统零成本标出来，点不点由用户决定 */}
                    {(minimalReport.deepenSuggestions?.length ?? 0) > 0 && (
                      <details className="group">
                        <summary className="cursor-pointer text-[11px] text-violet-700 hover:underline">
                          建议读内容的文件（{minimalReport.deepenSuggestions!.length}）——在已归档文件里右键「提取事实并复核」
                        </summary>
                        <div className="mt-1.5 space-y-1">
                          {minimalReport.deepenSuggestions!.map(item => (
                            <p
                              key={item.sourcePath}
                              className="break-words text-[11px] leading-4 text-muted-foreground"
                            >
                              <span className="font-medium text-foreground">
                                {item.sourcePath.split(/[/\\]/).pop()}
                              </span>
                              ：{item.reason}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}

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
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {batchProgress?.paused ? (
                          <Pause className="h-4 w-4 shrink-0 text-amber-600" />
                        ) : (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                        )}
                        <span className="truncate text-sm">
                          {batchProgress
                            ? `${BATCH_PHASE_LABELS[batchProgress.phase]}（${
                                batchProgress.done
                              }/${batchProgress.total}）${
                                batchProgress.paused ? ' — 已暂停' : ''
                              }`
                            : '正在处理文件...'}
                        </span>
                      </div>
                      {batchProgress && (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleTogglePause}
                          >
                            {batchProgress.paused ? (
                              <><Play className="h-3.5 w-3.5 mr-1" />继续</>
                            ) : (
                              <><Pause className="h-3.5 w-3.5 mr-1" />暂停</>
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={handleAbortBatch}
                          >
                            <Square className="h-3.5 w-3.5 mr-1" />
                            中断
                          </Button>
                        </div>
                      )}
                    </div>
                    <Progress value={processingProgress} className="h-2" />
                    {batchProgress?.currentFile && (
                      <p className="truncate text-xs text-muted-foreground">
                        当前文件：{batchProgress.currentFile}
                      </p>
                    )}
                    {batchProgress?.paused && (
                      <p className="text-xs text-amber-700">
                        当前文件会分析完，之后暂不继续下一个。
                      </p>
                    )}
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
                  {batchReviewFiles.length > 0 ? (
                    // 批量结果只在预览弹窗里操作。这里再铺一遍结果卡片的话，
                    // 会出现两套确认入口，可能对同一份文件发出两次归档请求。
                    <div className="space-y-3 py-6 text-center">
                      <Archive className="mx-auto h-8 w-8 text-primary/40" />
                      <p className="text-sm">
                        本批 {batchReviewFiles.length} 个文件已分析完成
                      </p>
                      <p className="text-xs text-muted-foreground">
                        在归档预览里按文件树查看、调整位置，然后一键归档
                      </p>
                      <div className="flex justify-center gap-2">
                        <Button size="sm" onClick={() => setBatchReviewOpen(true)}>
                          <Archive className="mr-1 h-4 w-4" />
                          打开归档预览
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleDiscardBatch}
                        >
                          <X className="mr-1 h-4 w-4" />
                          放弃这一批
                        </Button>
                      </div>
                    </div>
                  ) : results.length > 0 ? (
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

      {/* 批量归档预览：只在一次上传多份文件时出现 */}
      {batchReviewFiles.length > 0 && (
        <BatchReviewDialog
          open={batchReviewOpen}
          onOpenChange={setBatchReviewOpen}
          files={batchReviewFiles}
          projectName={selectedProject?.name ?? ''}
          archiving={batchArchiving}
          archiveProgress={batchArchiveProgress}
          onChangeFolder={(clientId, folder) =>
            setBatchFolderOverrides(current => ({
              ...current,
              [clientId]: folder,
            }))
          }
          onArchiveAll={() => void handleBatchArchiveAll()}
          onShowDetails={setBatchDetailsClientId}
          detailsResult={
            results.find(result => result.clientId === batchDetailsClientId) ??
            null
          }
          onCloseDetails={() => setBatchDetailsClientId(null)}
          onExtractFacts={clientId => void handleExtractFacts(clientId)}
          extractingClientId={extractingClientId}
        />
      )}
    </div>
  );
}
