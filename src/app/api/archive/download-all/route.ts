import { NextRequest, NextResponse } from "next/server";
import { listArchivedFiles, getFileDownloadStream, getProject } from "@/lib/storage";
import AdmZip from "adm-zip";

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

    const zip = new AdmZip();
    const safeProjectName = project.name.replace(/[/\\:*?"<>|]/g, "-");

    // 下载文件并按文件夹结构添加到 ZIP
    for (const file of files) {
      try {
        const result = await getFileDownloadStream(file.id);
        if (result?.buffer) {
          const folderPath = file.folderPath.slice(1).join("/");
          const entryPath = `${safeProjectName}/${folderPath}/${file.archivedName}`;
          zip.addFile(entryPath, result.buffer);
        }
      } catch (downloadError) {
        console.error(`Failed to download file ${file.id}:`, downloadError);
      }
    }

    const zipBuffer = zip.toBuffer();
    const zipFileName = `${safeProjectName}-归档文件-${new Date().toISOString().slice(0, 10)}.zip`;

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
