'use client';

import { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  Folder, FolderOpen, FileText, Upload, CheckCircle2, AlertCircle,
  ChevronRight, ChevronDown, Loader2, ArrowRight, Brain, Search, Zap,
  Plus, Trash2, Download, Archive, Building2, Clock, FileIcon, X,
  ChevronLeft, History, ArrowRightLeft
} from 'lucide-react';
import { FOLDER_STRUCTURE, type FolderNode, type FlatFileCategory, type Project, type ArchivedFile } from '@/lib/folder-structure';

// 类型定义
interface KeywordMatchDetail {
  categoryName: string;
  folderPath: string[];
  score: number;
  matchedKeywords: string[];
  fileNameMatches: string[];
  contentMatches: string[];
}

interface ClassifyProcess {
  step1_keywordMatch: {
    totalCategories: number;
    matchedCategories: number;
    details: KeywordMatchDetail[];
    bestMatch?: KeywordMatchDetail;
    threshold: number;
    passed: boolean;
  };
  step2_llmAnalysis?: {
    triggered: boolean;
    reason: string;
    result?: { categoryName: string; confidence: number; reasoning: string; };
  };
  finalDecision: {
    method: 'keyword' | 'llm' | 'fallback' | 'none';
    explanation: string;
  };
}

interface ClassifyResult {
  fileName: string;
  fileSize: number;
  category: FlatFileCategory | null;
  confidence: number;
  reasoning: string;
  contentPreview?: string;
  process: ClassifyProcess;
  archived?: { id: string; archivedName: string; projectName: string; folderPath: string[]; };
}

// ============ 文件夹树组件 ============
function FolderTree({ node, level = 0, selectedFolder, onSelectFolder }: {
  node: FolderNode; level?: number; selectedFolder: string | null; onSelectFolder: (id: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(level < 2);
  const hasChildren = node.children && node.children.length > 0;
  const hasFiles = node.files && node.files.length > 0;
  const isSelected = selectedFolder === node.id;

  return (
    <div className="select-none">
      <div
        className={`flex items-center gap-1 py-1.5 px-2 rounded cursor-pointer transition-colors ${isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => { if (hasChildren) setIsOpen(!isOpen); onSelectFolder(node.id); }}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (<span className="w-4 shrink-0" />)}
        {hasChildren ? (
          isOpen ? <FolderOpen className="h-4 w-4 text-primary shrink-0" /> : <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (<Folder className="h-4 w-4 text-muted-foreground shrink-0" />)}
        <span className="text-sm font-medium truncate">{node.name}</span>
        {hasFiles && <Badge variant="outline" className="ml-auto text-xs shrink-0">{node.files?.length}</Badge>}
      </div>
      {isOpen && hasChildren && (
        <div>
          {node.children!.map(child => (
            <FolderTree key={child.id} node={child} level={level + 1} selectedFolder={selectedFolder} onSelectFolder={onSelectFolder} />
          ))}
        </div>
      )}
      {isOpen && hasFiles && (
        <div style={{ paddingLeft: `${(level + 1) * 16 + 24}px` }}>
          {node.files!.map((file, idx) => (
            <div key={idx} className="flex items-center gap-2 py-1 text-muted-foreground">
              <FileText className="h-3 w-3 shrink-0" />
              <span className="text-xs truncate">{file.name}</span>
            </div>
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
      className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-all ${disabled ? 'opacity-50 pointer-events-none' : ''} ${isDragging ? 'border-primary bg-primary/5 scale-[1.02]' : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'}`}
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
    <div className="mt-3 border rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 bg-muted/50 hover:bg-muted transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">查看分类过程</span>
          <Badge variant="outline" className="text-xs">
            {process.finalDecision.method === 'keyword' ? '关键词匹配' : process.finalDecision.method === 'llm' ? 'AI 分析' : process.finalDecision.method === 'fallback' ? '降级匹配' : '未分类'}
          </Badge>
        </div>
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {isExpanded && (
        <div className="p-4 space-y-4 bg-background">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className={`p-1.5 rounded ${process.step1_keywordMatch.passed ? 'bg-green-100' : 'bg-amber-100'}`}>
                <Search className={`h-4 w-4 ${process.step1_keywordMatch.passed ? 'text-green-600' : 'text-amber-600'}`} />
              </div>
              <span className="text-sm font-medium">步骤 1：关键词匹配</span>
              {process.step1_keywordMatch.passed ? <Badge className="bg-green-100 text-green-700 text-xs">通过</Badge> : <Badge variant="outline" className="text-xs">未通过</Badge>}
            </div>
            <div className="pl-8 space-y-2 text-sm">
              <p className="text-muted-foreground">
                扫描 <span className="font-medium text-foreground">{process.step1_keywordMatch.totalCategories}</span> 个文件类别，匹配到 <span className="font-medium text-foreground">{process.step1_keywordMatch.matchedCategories}</span> 个
              </p>
              <p className="text-muted-foreground">
                阈值：<span className="font-medium">{process.step1_keywordMatch.threshold} 分</span>
                {process.step1_keywordMatch.bestMatch && <span>，最高得分：<span className="font-medium">{process.step1_keywordMatch.bestMatch.score} 分</span></span>}
              </p>
              {process.step1_keywordMatch.details.length > 0 && (
                <div className="space-y-1 mt-2">
                  <p className="text-xs text-muted-foreground">匹配详情（前 5 名）：</p>
                  {process.step1_keywordMatch.details.slice(0, 5).map((detail, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-2 text-xs bg-muted/50 p-2 rounded">
                      <span className="font-medium text-foreground">{detail.categoryName}</span>
                      <span className="text-muted-foreground">得分: {detail.score}</span>
                      <span className="text-muted-foreground">|</span>
                      <span className="text-muted-foreground">文件名: {detail.fileNameMatches.length > 0 ? detail.fileNameMatches.join(', ') : '无'}</span>
                      <span className="text-muted-foreground">|</span>
                      <span className="text-muted-foreground">内容: {detail.contentMatches.length > 0 ? detail.contentMatches.join(', ') : '无'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <Separator />
          {process.step2_llmAnalysis && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className={`p-1.5 rounded ${process.step2_llmAnalysis.result ? 'bg-blue-100' : 'bg-muted'}`}>
                  <Brain className={`h-4 w-4 ${process.step2_llmAnalysis.result ? 'text-blue-600' : 'text-muted-foreground'}`} />
                </div>
                <span className="text-sm font-medium">步骤 2：AI 智能分析</span>
                {process.step2_llmAnalysis.result && <Badge className="bg-blue-100 text-blue-700 text-xs">置信度 {process.step2_llmAnalysis.result.confidence}%</Badge>}
              </div>
              <div className="pl-8 space-y-2 text-sm">
                <p className="text-muted-foreground">{process.step2_llmAnalysis.triggered ? process.step2_llmAnalysis.reason : '关键词匹配已通过，无需 AI 分析'}</p>
                {process.step2_llmAnalysis.result && (
                  <div className="bg-blue-50 p-3 rounded text-sm">
                    <p className="font-medium text-blue-900">AI 判断结果：</p>
                    <p className="text-blue-700 mt-1">分类：{process.step2_llmAnalysis.result.categoryName}</p>
                    <p className="text-blue-700">理由：{process.step2_llmAnalysis.result.reasoning}</p>
                  </div>
                )}
              </div>
            </div>
          )}
          <Separator />
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded bg-primary/10"><CheckCircle2 className="h-4 w-4 text-primary" /></div>
              <span className="text-sm font-medium">最终决策</span>
            </div>
            <div className="pl-8 text-sm"><p className="text-muted-foreground">{process.finalDecision.explanation}</p></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 分类结果项 ============
function ClassifyResultItem({ result }: { result: ClassifyResult }) {
  return (
    <Card className={`transition-all ${result.category ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-amber-500'}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg ${result.category ? 'bg-green-100' : 'bg-amber-100'}`}>
            {result.category ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <AlertCircle className="h-5 w-5 text-amber-600" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className="font-medium truncate">{result.fileName}</p>
              <span className="text-xs text-muted-foreground shrink-0">{(result.fileSize / 1024).toFixed(1)} KB</span>
            </div>
            {result.category ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-primary font-medium truncate">{result.category.folderPath.join(' / ')} / {result.category.fileName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Progress value={result.confidence} className="h-1.5 w-24" />
                  <span className="text-xs text-muted-foreground">置信度 {result.confidence}%</span>
                </div>
                <p className="text-sm text-muted-foreground bg-muted/50 p-2 rounded">{result.reasoning}</p>
                {result.archived && (
                  <div className="flex items-center gap-2 text-sm bg-green-50 p-2 rounded">
                    <Archive className="h-4 w-4 text-green-600" />
                    <span className="text-green-700">
                      已归档至 <span className="font-medium">{result.archived.projectName}</span> →
                      文件名：<span className="font-mono text-xs">{result.archived.archivedName}</span>
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{result.reasoning}</p>
            )}
            {result.contentPreview && (
              <div className="mt-2 p-2 bg-muted/30 rounded text-xs text-muted-foreground max-h-24 overflow-hidden">{result.contentPreview}</div>
            )}
            {result.process && <ClassifyProcessPanel process={result.process} />}
          </div>
        </div>
      </CardContent>
    </Card>
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
  type: 'folder' | 'file';
  children?: ArchiveTreeNode[];
  file?: {
    id: string;
    originalName: string;
    archivedName: string;
    categoryName: string;
    fileSize: number;
    mimeType: string;
    archivedAt: string;
    confidence: number;
  };
}

// ============ 移动文件对话框 ============

interface MoveTarget {
  categoryId: string;
  categoryName: string;
  folderPath: string[];
  label: string;
}

function getMoveTargets(node: FolderNode, parentPath: string[] = []): MoveTarget[] {
  const currentPath = [...parentPath, node.name];
  const targets: MoveTarget[] = [];

  if (node.children) {
    for (const child of node.children) {
      if (child.children && child.children.length > 0) {
        targets.push(...getMoveTargets(child, currentPath));
      } else {
        // 叶子节点（无论是否有 files 模板，都作为可移动目标）
        targets.push({
          categoryId: child.id ?? child.name,
          categoryName: child.name,
          folderPath: currentPath,
          label: `${currentPath.join(' / ')} / ${child.name}`,
        });
      }
    }
  }

  return targets;
}

const MOVE_TARGETS = getMoveTargets(FOLDER_STRUCTURE);

function MoveFileDialog({
  file,
  onMove,
  onCancel,
  moving,
}: {
  file: ArchivedFile;
  onMove: (categoryId: string, categoryName: string, folderPath: string[]) => void;
  onCancel: () => void;
  moving: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [newSubfolder, setNewSubfolder] = useState("");

  // 计算最终目标
  const getFinalTarget = () => {
    const target = MOVE_TARGETS.find(t => t.categoryId === selectedId);
    if (!target) return null;

    if (newSubfolder.trim()) {
      // 在选中的分类下新建子文件夹
      const subName = newSubfolder.trim();
      return {
        categoryId: `${target.categoryId}-${subName}`,
        categoryName: subName,
        folderPath: [...target.folderPath, target.categoryName],
      };
    }
    return {
      categoryId: target.categoryId,
      categoryName: target.categoryName,
      folderPath: target.folderPath,
    };
  };

  return (
    <Dialog open={true} onOpenChange={() => onCancel()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            移动归档文件
          </DialogTitle>
          <DialogDescription>
            将「<span className="font-medium text-foreground">{file.archivedName}</span>」移动到新的分类文件夹
          </DialogDescription>
        </DialogHeader>

        <div className="text-xs text-muted-foreground mb-2">
          当前位置：{file.folderPath.join(' / ')} / {file.categoryName}
        </div>

        <ScrollArea className="flex-1 border rounded-lg p-3 max-h-[300px]">
          <div className="space-y-0.5">
            {MOVE_TARGETS.map((target) => (
              <label
                key={target.categoryId}
                className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-colors ${
                  selectedId === target.categoryId
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-muted'
                }`}
              >
                <input
                  type="radio"
                  name="moveTarget"
                  value={target.categoryId}
                  checked={selectedId === target.categoryId}
                  onChange={() => { setSelectedId(target.categoryId); setNewSubfolder(""); }}
                  className="sr-only"
                />
                <div
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    selectedId === target.categoryId
                      ? 'border-primary'
                      : 'border-muted-foreground/30'
                  }`}
                >
                  {selectedId === target.categoryId && (
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  )}
                </div>
                <span className="text-sm truncate">{target.label}</span>
              </label>
            ))}
          </div>
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
              className="h-8 text-sm"
            />
            {newSubfolder.trim() && (
              <div className="text-xs text-muted-foreground">
                目标路径：{(() => {
                  const t = MOVE_TARGETS.find(t => t.categoryId === selectedId);
                  return t ? `${t.folderPath.join(' / ')} / ${t.categoryName} / ${newSubfolder.trim()}` : '';
                })()}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onCancel} disabled={moving}>
            取消
          </Button>
          <Button
            onClick={() => {
              const target = getFinalTarget();
              if (target) onMove(target.categoryId, target.categoryName, target.folderPath);
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
function ArchiveTreeItem({ node, level, onDownload, onDelete, onMove }: {
  node: ArchiveTreeNode;
  level: number;
  onDownload: (fileId: string) => void;
  onDelete: (fileId: string) => void;
  onMove: (fileId: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(level < 2);
  const hasChildren = node.children && node.children.length > 0;
  const fileCount = node.children?.filter(c => c.type === 'file').length || 0;

  if (node.type === 'file' && node.file) {
    return (
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 transition-colors group"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate" title={node.file.archivedName}>{node.file.archivedName}</p>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{(node.file.fileSize / 1024).toFixed(1)} KB</span>
            <span>·</span>
            <span>{new Date(node.file.archivedAt).toLocaleDateString('zh-CN')}</span>
            <span>·</span>
            <span>置信度 {node.file.confidence}%</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onMove(node.file!.id)} title="移动">
            <ArrowRightLeft className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onDownload(node.file!.id)} title="下载">
            <Download className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => onDelete(node.file!.id)} title="删除">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="select-none">
      <div
        className="flex items-center gap-1 py-1.5 px-2 rounded cursor-pointer hover:bg-muted/50 transition-colors"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        {isOpen ? <FolderOpen className="h-3.5 w-3.5 text-primary shrink-0" /> : <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        <span className="text-xs font-medium truncate">{node.name}</span>
        {fileCount > 0 && <Badge variant="outline" className="ml-auto text-[10px] px-1 py-0 shrink-0">{fileCount}</Badge>}
      </div>
      {isOpen && hasChildren && (
        <div>
          {node.children!.map((child, idx) => (
            <ArchiveTreeItem key={`${child.path}-${idx}`} node={child} level={level + 1} onDownload={onDownload} onDelete={onDelete} onMove={onMove} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============ 归档文件列表 ============
function ArchivedFilesList({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [tree, setTree] = useState<ArchiveTreeNode[]>([]);
  const [files, setFiles] = useState<ArchivedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const moveTarget = moveTargetId ? files.find(f => f.id === moveTargetId) : null;

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    fetch(`/api/archive?projectId=${projectId}&tree=true`)
      .then(r => r.json())
      .then(data => {
        setTree(data.tree || []);
        setFiles(data.files || []);
      })
      .finally(() => setLoading(false));
  }, [projectId, refreshKey]);

  const handleDownload = (fileId: string) => {
    window.open(`/api/archive?download=${fileId}&id=${fileId}`, '_blank');
  };

  const handleDelete = async (fileId: string) => {
    const file = files.find(f => f.id === fileId);
    if (!file) return;
    if (!confirm(`确定删除「${file.archivedName}」？`)) return;
    await fetch(`/api/archive?id=${fileId}`, { method: 'DELETE' });
    setFiles(prev => prev.filter(f => f.id !== fileId));
    setTree(prev => removeFileFromTree(prev, fileId));
  };

  const handleMove = async (targetCategoryId: string, targetCategoryName: string, targetFolderPath: string[]) => {
    if (!moveTarget) return;
    setMoving(true);
    try {
      const res = await fetch('/api/archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: moveTarget.id,
          categoryId: targetCategoryId,
          categoryName: targetCategoryName,
          folderPath: targetFolderPath,
        }),
      });
      if (!res.ok) throw new Error('移动失败');
      // 刷新列表
      const refreshRes = await fetch(`/api/archive?projectId=${projectId}&tree=true`);
      const data = await refreshRes.json();
      setTree(data.tree || []);
      setFiles(data.files || []);
      setMoveTargetId(null);
    } catch (err) {
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
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-muted-foreground">共 {files.length} 个文件</span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
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
            onDelete={handleDelete}
            onMove={setMoveTargetId}
          />
        ))}
      </div>

      {/* Move File Dialog */}
      {moveTarget && (
        <MoveFileDialog
          file={moveTarget}
          onMove={handleMove}
          onCancel={() => setMoveTargetId(null)}
          moving={moving}
        />
      )}
    </div>
  );
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
  categoryName: string;
  folderPath: string[];
  fileSize: number;
  confidence: number;
  archivedAt: string;
}

function AnalysisHistoryPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    fetch(`/api/archive?projectId=${projectId}`)
      .then(r => r.json())
      .then(data => {
        setRecords(data.files || []);
      })
      .finally(() => setLoading(false));
  }, [projectId, refreshKey]);

  if (loading) {
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
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-muted-foreground">共 {records.length} 条记录</span>
      </div>
      <div className="space-y-2">
        {records.map((record) => (
          <div
            key={record.id}
            className="flex items-start gap-3 p-3 rounded-lg border bg-background hover:bg-muted/30 transition-colors"
          >
            <div className="p-1.5 rounded bg-primary/10 shrink-0 mt-0.5">
              <FileText className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate" title={record.originalName}>
                  {record.originalName}
                </span>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {(record.fileSize / 1024).toFixed(1)} KB
                </Badge>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ArrowRight className="h-3 w-3 shrink-0" />
                <span className="font-mono text-[11px] truncate" title={record.archivedName}>
                  {record.archivedName}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
                <span className="flex items-center gap-1">
                  <Folder className="h-3 w-3" />
                  {record.folderPath.join(' / ')}
                </span>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {new Date(record.archivedAt).toLocaleString('zh-CN', {
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit'
                  })}
                </span>
                <span>·</span>
                <span>置信度 {record.confidence}%</span>
              </div>
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

  // 项目管理
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0);
  // 新增项目动画
  const [newProjectId, setNewProjectId] = useState<string | null>(null);

  // 加载项目列表
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => {
        setProjects(data.projects || []);
        if (data.projects?.length > 0 && !selectedProjectId) {
          setSelectedProjectId(data.projects[0].id);
        }
      });
  }, []);

  const handleProjectCreated = (project: Project) => {
    setProjects(prev => [project, ...prev]);
    setSelectedProjectId(project.id);
    // 触发动画
    setNewProjectId(project.id);
    setTimeout(() => setNewProjectId(null), 600);
  };

  const handleDeleteProject = async (id: string) => {
    if (!confirm('确定删除该项目及其所有归档文件？此操作不可恢复。')) return;
    await fetch(`/api/projects?id=${id}`, { method: 'DELETE' });
    setProjects(prev => prev.filter(p => p.id !== id));
    if (selectedProjectId === id) {
      const remaining = projects.filter(p => p.id !== id);
      setSelectedProjectId(remaining[0]?.id || '');
    }
  };

  const handleFileUpload = useCallback(async (files: FileList) => {
    if (!selectedProjectId) {
      alert('请先选择或创建一个项目');
      return;
    }

    setIsProcessing(true);
    setProcessingProgress(0);
    setResults([]);

    const totalFiles = files.length;
    let processedFiles = 0;

    for (const file of Array.from(files)) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('projectId', selectedProjectId);
        formData.append('autoArchive', 'true');

        const response = await fetch('/api/classify', {
          method: 'POST',
          body: formData
        });

        if (!response.ok) throw new Error('分类请求失败');

        const result = await response.json();
        setResults(prev => [...prev, result]);
      } catch (error) {
        setResults(prev => [...prev, {
          fileName: file.name, fileSize: file.size, category: null, confidence: 0,
          reasoning: '文件处理失败，请重试',
          process: {
            step1_keywordMatch: { totalCategories: 0, matchedCategories: 0, details: [], threshold: 5, passed: false },
            finalDecision: { method: 'none' as const, explanation: '文件处理失败' }
          }
        }]);
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
  }, [selectedProjectId]);

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">投资项目档案管理系统</h1>
              <p className="text-sm text-muted-foreground">智能文件分类 · 自动归档 · 按项目管理</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-sm">国创致远</Badge>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Sidebar: Folder Structure + Projects */}
          <div className="lg:col-span-3 space-y-4">
            {/* Project Selection */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2">
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
                  <ScrollArea className="h-[200px]">
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
                            <p className="text-xs text-muted-foreground">{project.fileCount} 个文件</p>
                          </div>
                          <Button
                            variant="ghost" size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive shrink-0 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); handleDeleteProject(project.id); }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>

            {/* Folder Structure */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Folder className="h-5 w-5 text-primary" />
                  文件夹结构
                </CardTitle>
                <CardDescription>基于《国创致远-投资项目档案管理》文档</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[calc(100vh-520px)] min-h-[200px]">
                  <FolderTree node={FOLDER_STRUCTURE} selectedFolder={selectedFolder} onSelectFolder={setSelectedFolder} />
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Middle: Upload + Results */}
          <div className="lg:col-span-5 space-y-6">
            {/* Upload Section */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Upload className="h-5 w-5 text-primary" />
                  文件上传
                </CardTitle>
                <CardDescription>
                  {selectedProject
                    ? `当前项目：${selectedProject.name} — 上传文件将自动分类并归档`
                    : '请先在左侧选择或创建一个项目'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UploadZone onFileUpload={handleFileUpload} disabled={!selectedProjectId} />
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

            {/* Results */}
            {results.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                    分类结果
                  </CardTitle>
                  <CardDescription>已处理 {results.length} 个文件</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {results.map((result, index) => (
                    <ClassifyResultItem key={index} result={result} />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Empty State */}
            {results.length === 0 && !isProcessing && (
              <Card className="bg-muted/30">
                <CardContent className="p-6">
                  <div className="text-center space-y-3">
                    <div className="text-4xl">📁</div>
                    <h3 className="font-semibold">开始使用</h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                      1. 创建或选择一个投资项目<br />
                      2. 上传文件，系统自动分类<br />
                      3. 文件自动归档到项目文件夹
                    </p>
                    <Separator className="my-4" />
                    <div className="grid grid-cols-4 gap-4 text-center">
                      <div><div className="text-2xl font-bold text-primary">50+</div><div className="text-xs text-muted-foreground">文件类型</div></div>
                      <div><div className="text-2xl font-bold text-primary">AI</div><div className="text-xs text-muted-foreground">智能分析</div></div>
                      <div><div className="text-2xl font-bold text-primary">自动</div><div className="text-xs text-muted-foreground">归档命名</div></div>
                      <div><div className="text-2xl font-bold text-primary">100%</div><div className="text-xs text-muted-foreground">自动化</div></div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right: Archived Files + Analysis History */}
          <div className="lg:col-span-4 space-y-4">
            {/* Archived Files */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Archive className="h-5 w-5 text-primary" />
                  已归档文件
                </CardTitle>
                <CardDescription>
                  {selectedProject
                    ? `${selectedProject.name} — ${selectedProject.fileCount} 个文件`
                    : '请选择一个项目查看归档文件'}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[300px]">
                  {selectedProjectId ? (
                    <ArchivedFilesList projectId={selectedProjectId} refreshKey={archiveRefreshKey} />
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">未选择项目</p>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Analysis History */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <History className="h-5 w-5 text-primary" />
                  分析记录
                </CardTitle>
                <CardDescription>
                  {selectedProject
                    ? `文件上传时间、原始名称与归档后名称`
                    : '请选择一个项目查看分析记录'}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[300px]">
                  {selectedProjectId ? (
                    <AnalysisHistoryPanel projectId={selectedProjectId} refreshKey={archiveRefreshKey} />
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">未选择项目</p>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
