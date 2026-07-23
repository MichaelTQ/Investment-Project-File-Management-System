import { NextRequest, NextResponse } from 'next/server';
import { getAllArchivedFiles, getProjectFiles, deleteArchivedFile, getFilePath } from '@/lib/storage';
import fs from 'fs';

export const runtime = 'nodejs';

// 归档文件树节点
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

// 将归档文件列表构建为树形结构
function buildArchiveTree(files: import('@/lib/folder-structure').ArchivedFile[]): ArchiveTreeNode[] {
  const root: ArchiveTreeNode[] = [];

  for (const file of files) {
    // folderPath 如 ["投资项目档案", "基金投资及投资执行", "项目立项"]
    const parts = file.folderPath;

    let currentLevel = root;
    for (let i = 0; i < parts.length; i++) {
      const partName = parts[i];
      const isLast = i === parts.length - 1;

      let existing = currentLevel.find(n => n.name === partName && n.type === 'folder');
      if (!existing) {
        existing = {
          name: partName,
          path: parts.slice(0, i + 1).join('/'),
          type: 'folder',
          children: []
        };
        currentLevel.push(existing);
      }

      if (isLast) {
        // 添加文件节点
        existing.children!.push({
          name: file.archivedName,
          path: [...file.folderPath, file.archivedName].join('/'),
          type: 'file',
          file: {
            id: file.id,
            originalName: file.originalName,
            archivedName: file.archivedName,
            categoryName: file.categoryName,
            fileSize: file.fileSize,
            mimeType: file.mimeType,
            archivedAt: file.archivedAt,
            confidence: file.confidence
          }
        });
      }

      currentLevel = existing.children!;
    }
  }

  return root;
}

// GET - 获取归档文件列表（支持树形结构）
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const downloadId = searchParams.get('download');
    const tree = searchParams.get('tree') === 'true';

    // 文件下载
    if (downloadId) {
      const allFiles = getAllArchivedFiles();
      const file = allFiles.find(f => f.id === downloadId);
      if (!file) {
        return NextResponse.json({ error: '文件不存在' }, { status: 404 });
      }

      const filePath = getFilePath(file);
      if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: '文件已被删除' }, { status: 404 });
      }

      const fileBuffer = fs.readFileSync(filePath);
      return new NextResponse(fileBuffer, {
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.archivedName)}`,
          'Content-Length': String(fileBuffer.length)
        }
      });
    }

    // 文件列表
    const files = projectId ? getProjectFiles(projectId) : getAllArchivedFiles();

    if (tree) {
      const treeData = buildArchiveTree(files);
      return NextResponse.json({ tree: treeData, files });
    }

    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(
      { error: '获取归档文件失败', details: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}

// DELETE - 删除归档文件
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: '缺少文件 ID' }, { status: 400 });
    }

    const success = deleteArchivedFile(id);
    if (!success) {
      return NextResponse.json({ error: '文件不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: '删除文件失败', details: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}
