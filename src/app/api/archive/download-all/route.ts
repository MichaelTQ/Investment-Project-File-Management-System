import { NextRequest, NextResponse } from "next/server";
import { listArchivedFiles, getFileDownloadStream, getProject } from "@/lib/storage";
import { buildZipEntryPaths, buildZipFileName } from "@/lib/archive-zip";
import { FOLDER_STRUCTURE } from "@/lib/folder-structure";
import AdmZip from "adm-zip";

export const runtime = "nodejs";

/**
 * 打包下载。
 *
 * GET  = 整个项目（保持原来的行为，前端"一键下载全部"还在用）。
 * POST = 指定一批文件 id，用于下载单个文件夹或跨层级勾选的结果。
 *
 * 两条路都走同一套打包逻辑，压缩包里的目录结构和网页上的归档树一致。
 */
async function buildZipResponse(params: {
  projectId: string;
  /** 只打包这些文件；不传就是整个项目。 */
  fileIds?: string[];
  /** 包的根目录对应哪一段归档路径，下载单个文件夹时传。 */
  basePath?: string[];
  /** 压缩包文件名里用的名字，不传就用项目名。 */
  label?: string;
}) {
  const { projectId, fileIds, basePath, label } = params;

  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const allFiles = await listArchivedFiles(projectId);
  // 只按 id 过滤本项目的文件：id 是前端传来的，不能让它跨项目取文件。
  const files = fileIds
    ? (() => {
        const wanted = new Set(fileIds);
        return allFiles.filter(file => wanted.has(file.id));
      })()
    : allFiles;

  if (files.length === 0) {
    return NextResponse.json(
      { error: fileIds ? "所选文件已不存在，请刷新后重试" : "该项目没有归档文件" },
      { status: 404 }
    );
  }

  const entryPaths = buildZipEntryPaths(files, {
    // 没指定文件夹时（整项目、跨层级勾选）把根目录钉在归档树的根上，不去猜公共前缀：
    // 选中的文件常常凑巧都落在同一个分组层（比如全在"基金投资及投资执行"下），
    // 按公共前缀砍就会把项目名那一层连带砍掉。
    basePath: basePath ?? [FOLDER_STRUCTURE.name],
    // 归档路径第一段对所有项目都是"投资项目档案"，换成项目名才认得出是哪个项目的包。
    rootLabel: project.name,
  });

  const zip = new AdmZip();
  const failed: string[] = [];
  for (const file of files) {
    try {
      const result = await getFileDownloadStream(file.id);
      if (result?.buffer) {
        zip.addFile(entryPaths.get(file.id)!, result.buffer);
      } else {
        failed.push(file.archivedName);
      }
    } catch (downloadError) {
      failed.push(file.archivedName);
      console.error(`Failed to download file ${file.id}:`, downloadError);
    }
  }

  // 一个都没读出来时不要回一个空压缩包——那看起来像下载成功了。
  if (zip.getEntries().length === 0) {
    return NextResponse.json(
      { error: "所选文件都无法读取，请重试", details: failed.join("、") },
      { status: 502 }
    );
  }

  const zipBuffer = zip.toBuffer();
  const zipFileName = buildZipFileName(
    label ? `${label}-归档文件` : `${project.name}-归档文件`
  );

  return new NextResponse(new Uint8Array(zipBuffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zipFileName)}`,
      "Content-Length": String(zipBuffer.length),
      // 部分文件读失败时前端要能提示，但 body 已经是二进制了，只能走响应头。
      ...(failed.length > 0
        ? { "X-Archive-Skipped-Count": String(failed.length) }
        : {}),
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }
    return await buildZipResponse({ projectId });
  } catch (error) {
    return NextResponse.json(
      { error: "打包下载失败", details: error instanceof Error ? error.message : "未知错误" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    const fileIds = Array.isArray(body?.fileIds)
      ? body.fileIds.filter(
          (item: unknown): item is string =>
            typeof item === "string" && item.length > 0
        )
      : [];
    if (fileIds.length === 0) {
      return NextResponse.json({ error: "没有选中任何文件" }, { status: 400 });
    }

    const basePath = Array.isArray(body?.basePath)
      ? body.basePath.filter(
          (item: unknown): item is string => typeof item === "string"
        )
      : undefined;
    const label = typeof body?.label === "string" && body.label.trim()
      ? body.label.trim()
      : undefined;

    return await buildZipResponse({
      projectId,
      fileIds: [...new Set<string>(fileIds)],
      basePath,
      label,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "打包下载失败", details: error instanceof Error ? error.message : "未知错误" },
      { status: 500 }
    );
  }
}
