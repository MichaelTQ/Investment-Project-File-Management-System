import { NextRequest, NextResponse } from "next/server";
import { listArchivedFiles, getFileDownloadStream, getProject } from "@/lib/storage";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const files = await listArchivedFiles(projectId);
    if (files.length === 0) {
      return NextResponse.json({ error: "该项目没有归档文件" }, { status: 404 });
    }

    // 在临时目录创建文件夹结构
    const tmpDir = join(tmpdir(), `archive-dl-${randomUUID()}`);
    const projectDir = join(tmpDir, project.name.replace(/[/\\:*?"<>|]/g, "-"));
    mkdirSync(projectDir, { recursive: true });

    // 下载文件并按文件夹结构组织
    for (const file of files) {
      try {
        const result = await getFileDownloadStream(file.id);
        if (result?.buffer) {
          const folderPath = file.folderPath.slice(1).join("/");
          const fileDir = join(projectDir, folderPath);
          mkdirSync(fileDir, { recursive: true });
          writeFileSync(join(fileDir, file.archivedName), result.buffer);
        }
      } catch (downloadError) {
        console.error(`Failed to download file ${file.id}:`, downloadError);
      }
    }

    // 使用 zip 命令打包
    const safeName = project.name.replace(/[/\\:*?"<>|]/g, "-");
    const zipFileName = `${safeName}-归档文件-${new Date().toISOString().slice(0, 10)}.zip`;
    const zipPath = join(tmpdir(), `archive-zip-${randomUUID()}.zip`);

    const safeProjectName = project.name.replace(/[/\\:*?"<>|]/g, "-");
    execSync(`cd "${tmpDir}" && zip -r "${zipPath}" "${safeProjectName}"`, {
      timeout: 60000,
    });

    const zipBuffer = readFileSync(zipPath);

    // 清理临时文件
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(zipPath, { force: true });
    } catch {
      // 忽略清理错误
    }

    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zipFileName)}`,
        "Content-Length": String(zipBuffer.length),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "打包下载失败", details: error instanceof Error ? error.message : "未知错误" },
      { status: 500 }
    );
  }
}
