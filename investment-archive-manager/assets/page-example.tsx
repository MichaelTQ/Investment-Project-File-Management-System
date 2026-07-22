'use client';

import { useState, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  Folder, 
  FolderOpen, 
  FileText, 
  Upload, 
  CheckCircle2, 
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Loader2,
  ArrowRight
} from 'lucide-react';
import { FOLDER_STRUCTURE, type FolderNode, type FlatFileCategory } from '@/lib/folder-structure';

interface ClassifyResult {
  fileName: string;
  fileSize: number;
  category: FlatFileCategory | null;
  confidence: number;
  reasoning: string;
  contentPreview?: string;
}

// 文件夹树组件
function FolderTree({ 
  node, 
  level = 0, 
  selectedFolder,
  onSelectFolder
}: { 
  node: FolderNode; 
  level?: number;
  selectedFolder: string | null;
  onSelectFolder: (id: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(level < 2);
  const hasChildren = node.children && node.children.length > 0;
  const hasFiles = node.files && node.files.length > 0;
  const isSelected = selectedFolder === node.id;

  return (
    <div className="select-none">
      <div 
        className={`flex items-center gap-1 py-1.5 px-2 rounded cursor-pointer transition-colors ${
          isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => {
          if (hasChildren) setIsOpen(!isOpen);
          onSelectFolder(node.id);
        }}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />
        ) : (
          <span className="w-4" />
        )}
        {hasChildren ? (
          isOpen ? <FolderOpen className="h-4 w-4 text-primary" /> : <Folder className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Folder className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">{node.name}</span>
        {hasFiles && <Badge variant="outline" className="ml-auto text-xs">{node.files?.length}</Badge>}
      </div>
      
      {isOpen && hasChildren && (
        <div>
          {node.children!.map(child => (
            <FolderTree 
              key={child.id} 
              node={child} 
              level={level + 1}
              selectedFolder={selectedFolder}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      )}
      
      {isOpen && hasFiles && (
        <div style={{ paddingLeft: `${(level + 1) * 16 + 24}px` }}>
          {node.files!.map((file, idx) => (
            <div key={idx} className="flex items-center gap-2 py-1 text-muted-foreground">
              <FileText className="h-3 w-3" />
              <span className="text-xs">{file.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 文件上传区域
function UploadZone({ onFileUpload }: { onFileUpload: (files: FileList) => void }) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      onFileUpload(e.dataTransfer.files);
    }
  }, [onFileUpload]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileUpload(e.target.files);
    }
  }, [onFileUpload]);

  return (
    <div
      className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-all ${
        isDragging 
          ? 'border-primary bg-primary/5 scale-[1.02]' 
          : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.ppt,.pptx"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onChange={handleFileInput}
      />
      <div className="flex flex-col items-center gap-3">
        <div className={`p-4 rounded-full ${isDragging ? 'bg-primary/10' : 'bg-muted'}`}>
          <Upload className={`h-8 w-8 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <div>
          <p className="font-medium">拖拽文件到此处或点击上传</p>
          <p className="text-sm text-muted-foreground mt-1">
            支持 PDF、Word、Excel、PPT、TXT 格式
          </p>
        </div>
      </div>
    </div>
  );
}

// 分类结果项
function ClassifyResultItem({ result }: { result: ClassifyResult }) {
  return (
    <Card className={`transition-all ${result.category ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-amber-500'}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg ${result.category ? 'bg-green-100' : 'bg-amber-100'}`}>
            {result.category ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertCircle className="h-5 w-5 text-amber-600" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className="font-medium truncate">{result.fileName}</p>
              <span className="text-xs text-muted-foreground">
                {(result.fileSize / 1024).toFixed(1)} KB
              </span>
            </div>
            
            {result.category ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <span className="text-primary font-medium">
                    {result.category.folderPath.join(' / ')} / {result.category.fileName}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Progress value={result.confidence} className="h-1.5 w-24" />
                  <span className="text-xs text-muted-foreground">
                    置信度 {result.confidence}%
                  </span>
                </div>
                <p className="text-sm text-muted-foreground bg-muted/50 p-2 rounded">
                  {result.reasoning}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {result.reasoning}
              </p>
            )}
            
            {result.contentPreview && (
              <div className="mt-2 p-2 bg-muted/30 rounded text-xs text-muted-foreground max-h-24 overflow-hidden">
                {result.contentPreview}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [results, setResults] = useState<ClassifyResult[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);

  const handleFileUpload = useCallback(async (files: FileList) => {
    setIsProcessing(true);
    setProcessingProgress(0);
    setResults([]);

    const totalFiles = files.length;
    let processedFiles = 0;

    for (const file of Array.from(files)) {
      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/classify', {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          throw new Error('分类请求失败');
        }

        const result = await response.json();
        setResults(prev => [...prev, result]);
      } catch (error) {
        setResults(prev => [...prev, {
          fileName: file.name,
          fileSize: file.size,
          category: null,
          confidence: 0,
          reasoning: '文件处理失败，请重试'
        }]);
      }

      processedFiles++;
      setProcessingProgress(Math.round((processedFiles / totalFiles) * 100));
    }

    setIsProcessing(false);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">投资项目档案管理系统</h1>
              <p className="text-sm text-muted-foreground">智能文件分类与管理</p>
            </div>
            <Badge variant="outline" className="text-sm">国创致远</Badge>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Folder Structure */}
          <div className="lg:col-span-1">
            <Card className="sticky top-24">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Folder className="h-5 w-5 text-primary" />
                  文件夹结构
                </CardTitle>
                <CardDescription>
                  基于《国创致远-投资项目档案管理》文档
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[calc(100vh-280px)]">
                  <FolderTree 
                    node={FOLDER_STRUCTURE} 
                    selectedFolder={selectedFolder}
                    onSelectFolder={setSelectedFolder}
                  />
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Right: Upload and Results */}
          <div className="lg:col-span-2 space-y-6">
            {/* Upload Section */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Upload className="h-5 w-5 text-primary" />
                  文件上传
                </CardTitle>
                <CardDescription>
                  上传文件，系统将自动分析内容并推荐分类位置
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UploadZone onFileUpload={handleFileUpload} />
                
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

            {/* Results Section */}
            {results.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                    分类结果
                  </CardTitle>
                  <CardDescription>
                    已处理 {results.length} 个文件，点击结果查看详情
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {results.map((result, index) => (
                    <ClassifyResultItem key={index} result={result} />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Instructions */}
            {results.length === 0 && !isProcessing && (
              <Card className="bg-muted/30">
                <CardContent className="p-6">
                  <div className="text-center space-y-3">
                    <div className="text-4xl">📁</div>
                    <h3 className="font-semibold">开始使用</h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                      上传文件后，系统将自动分析文件内容，识别文件类型，
                      并根据关键词匹配推荐最合适的归档位置。
                    </p>
                    <Separator className="my-4" />
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="text-2xl font-bold text-primary">50+</div>
                        <div className="text-xs text-muted-foreground">文件类型</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-primary">AI</div>
                        <div className="text-xs text-muted-foreground">智能分析</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-primary">100%</div>
                        <div className="text-xs text-muted-foreground">自动化</div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}