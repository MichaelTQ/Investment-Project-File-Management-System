import { NextRequest, NextResponse } from 'next/server';
import { getAllArchivedFiles, getProjectFiles, deleteArchivedFile, getFilePath } from '@/lib/storage';
import fs from 'fs';

export const runtime = 'nodejs';

// GET - 获取归档文件列表
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const downloadId = searchParams.get('download');

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
