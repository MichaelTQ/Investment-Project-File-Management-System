import { NextRequest, NextResponse } from 'next/server';
import { getProjectFiles, getFilePath, getProjects } from '@/lib/storage';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json({ error: '缺少 projectId 参数' }, { status: 400 });
    }

    const projects = getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    }

    const files = getProjectFiles(projectId);
    if (files.length === 0) {
      return NextResponse.json({ error: '该项目没有归档文件' }, { status: 404 });
    }

    // 创建临时目录用于打包
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-download-'));
    const projectDir = path.join(tmpDir, project.name);

    try {
      // 按文件夹结构复制文件到临时目录
      for (const file of files) {
        const filePath = getFilePath(file);
        if (fs.existsSync(filePath)) {
          const targetDir = path.join(projectDir, ...file.folderPath.slice(1));
          fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(filePath, path.join(targetDir, file.archivedName));
        }
      }

      // 使用系统 zip 命令打包
      const safeName = project.name.replace(/[\/\\:*?"<>|]/g, '-');
      const zipFileName = `${safeName}-归档文件-${new Date().toISOString().slice(0, 10)}.zip`;
      const zipPath = path.join(tmpDir, zipFileName);

      execSync(`cd "${tmpDir}" && zip -r "${zipPath}" "${project.name}"`, { encoding: 'utf-8' });

      const zipBuffer = fs.readFileSync(zipPath);

      return new NextResponse(zipBuffer, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipFileName)}`,
          'Content-Length': String(zipBuffer.length)
        }
      });
    } finally {
      // 清理临时目录
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (error) {
    return NextResponse.json(
      { error: '打包下载失败', details: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}
