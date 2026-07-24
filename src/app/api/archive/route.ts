import { NextRequest, NextResponse } from "next/server";
import {
  listArchivedFiles,
  getArchivedFile,
  deleteArchivedFile,
  getFileDownloadUrl,
  getFileDownloadStream,
  buildArchiveTree,
} from "@/lib/storage";

// GET /api/archive - 获取归档文件列表
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId") ?? undefined;
    const tree = searchParams.get("tree") === "true";
    const download = searchParams.get("download");
    const id = searchParams.get("id");

    // 单个文件下载（签名 URL）
    if (download && id) {
      const result = await getFileDownloadUrl(id);
      if (!result) {
        return NextResponse.json({ error: "文件不存在" }, { status: 404 });
      }
      return NextResponse.json({ downloadUrl: result.url, fileName: result.fileName });
    }

    // 单个文件下载（流式）
    if (id && !tree) {
      const result = await getFileDownloadStream(id);
      if (!result) {
        return NextResponse.json({ error: "文件不存在" }, { status: 404 });
      }
      return new NextResponse(new Uint8Array(result.buffer), {
        headers: {
          "Content-Type": result.mimeType,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(result.fileName)}"`,
        },
      });
    }

    const files = await listArchivedFiles(projectId);

    if (tree) {
      const treeData = buildArchiveTree(files);
      return NextResponse.json({ tree: treeData, files });
    }

    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取归档文件失败" },
      { status: 500 }
    );
  }
}

// DELETE /api/archive - 删除归档文件
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "缺少文件 ID" }, { status: 400 });
    }
    await deleteArchivedFile(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除文件失败" },
      { status: 500 }
    );
  }
}
