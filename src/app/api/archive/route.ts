import { NextRequest, NextResponse } from "next/server";
import {
  listArchivedFiles,
  deleteArchivedFile,
  moveArchivedFile,
  getFileDownloadUrl,
  getFileDownloadStream,
  buildArchiveTree,
  archiveFile,
  archiveStoredFile,
  getProject,
} from "@/lib/storage";
import { FLAT_FILE_CATEGORIES } from "@/lib/folder-structure";

export const runtime = "nodejs";

// POST /api/archive - 用户确认 AI 建议名称后归档文件
export async function POST(request: NextRequest) {
  try {
    const isJsonRequest = request.headers
      .get("content-type")
      ?.includes("application/json");
    let file: File | null = null;
    let storageKey = "";
    let originalName = "";
    let fileSize = 0;
    let mimeType = "application/octet-stream";
    let projectId = "";
    let categoryId = "";
    let categoryName = "";
    let archiveTitle = "";
    let reasoning = "";
    let parsedConfidence = 0;
    let folderPath: string[] = [];

    if (isJsonRequest) {
      const body = await request.json();
      storageKey = String(body.storageKey || "");
      originalName = String(body.originalName || "");
      fileSize = Number(body.fileSize || 0);
      mimeType = String(body.mimeType || mimeType);
      projectId = String(body.projectId || "");
      categoryId = String(body.categoryId || "");
      categoryName = String(body.categoryName || "");
      archiveTitle = String(body.archiveTitle || "").trim();
      reasoning = String(body.reasoning || "");
      parsedConfidence = Number(body.confidence || 0);
      folderPath = Array.isArray(body.folderPath)
        ? body.folderPath.filter(
            (segment: unknown): segment is string =>
              typeof segment === "string"
          )
        : [];
    } else {
      const formData = await request.formData();
      const formFile = formData.get("file");
      file = formFile instanceof File ? formFile : null;
      originalName = file?.name || "";
      fileSize = file?.size || 0;
      mimeType = file?.type || mimeType;
      projectId = String(formData.get("projectId") ?? "");
      categoryId = String(formData.get("categoryId") ?? "");
      categoryName = String(formData.get("categoryName") ?? "");
      archiveTitle = String(formData.get("archiveTitle") ?? "").trim();
      reasoning = String(formData.get("reasoning") ?? "");
      parsedConfidence = Number(formData.get("confidence") ?? 0);

      try {
        const parsedFolderPath = JSON.parse(
          String(formData.get("folderPath") ?? "[]")
        );
        if (Array.isArray(parsedFolderPath)) {
          folderPath = parsedFolderPath.filter(
            (segment): segment is string => typeof segment === "string"
          );
        }
      } catch {
        return NextResponse.json({ error: "归档路径格式错误" }, { status: 400 });
      }
    }

    if (
      (!file && !storageKey) ||
      !originalName ||
      !projectId ||
      !categoryId ||
      !categoryName
    ) {
      return NextResponse.json(
        { error: "缺少文件、项目或分类信息" },
        { status: 400 }
      );
    }
    if (storageKey && !storageKey.startsWith(`uploads/${projectId}/`)) {
      return NextResponse.json({ error: "无效的 S3 临时文件地址" }, { status: 400 });
    }

    const category = FLAT_FILE_CATEGORIES.find(
      (item) =>
        item.folderId === categoryId &&
        item.fileName === categoryName &&
        JSON.stringify(item.folderPath) === JSON.stringify(folderPath)
    );
    if (!category) {
      return NextResponse.json({ error: "无效的归档分类" }, { status: 400 });
    }

    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const confidence = Number.isFinite(parsedConfidence)
      ? Math.max(0, Math.min(100, Math.round(parsedConfidence)))
      : 0;
    const archived = storageKey
      ? await archiveStoredFile({
          storageKey,
          originalName,
          fileSize,
          projectId,
          projectName: project.name,
          categoryId: category.folderId,
          categoryName: category.fileName,
          folderPath: category.folderPath,
          mimeType,
          confidence,
          reasoning,
          archiveTitle: archiveTitle || category.fileName,
        })
      : await archiveFile({
          fileBuffer: Buffer.from(await file!.arrayBuffer()),
          originalName,
          projectId,
          projectName: project.name,
          categoryId: category.folderId,
          categoryName: category.fileName,
          folderPath: category.folderPath,
          mimeType,
          confidence,
          reasoning,
          archiveTitle: archiveTitle || category.fileName,
        });

    return NextResponse.json({
      success: true,
      archived: {
        id: archived.id,
        archivedName: archived.archivedName,
        projectName: archived.projectName,
        folderPath: archived.folderPath,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "归档文件失败" },
      { status: 500 }
    );
  }
}

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

// DELETE /api/archive - 删除单个或多个归档文件
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    let ids = id ? [id] : [];

    if (!id) {
      const body = await request.json().catch(() => null);
      if (Array.isArray(body?.ids)) {
        ids = body.ids.filter(
          (item: unknown): item is string => typeof item === "string" && item.length > 0
        );
      }
    }

    if (ids.length === 0) {
      return NextResponse.json({ error: "缺少文件 ID" }, { status: 400 });
    }

    for (const fileId of [...new Set(ids)]) {
      await deleteArchivedFile(fileId);
    }

    return NextResponse.json({ success: true, deletedCount: ids.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除文件失败" },
      { status: 500 }
    );
  }
}

// PATCH /api/archive - 移动单个或多个归档文件到新分类
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (Array.isArray(body.moves)) {
      const moves = body.moves.filter(
        (move: unknown): move is {
          id: string;
          categoryId: string;
          categoryName: string;
          folderPath: string[];
        } => {
          if (!move || typeof move !== "object") return false;
          const item = move as Record<string, unknown>;
          return (
            typeof item.id === "string" &&
            typeof item.categoryId === "string" &&
            typeof item.categoryName === "string" &&
            Array.isArray(item.folderPath) &&
            item.folderPath.every(segment => typeof segment === "string")
          );
        }
      );

      if (moves.length === 0 || moves.length !== body.moves.length) {
        return NextResponse.json({ error: "批量移动参数格式错误" }, { status: 400 });
      }

      const movedFiles = [];
      for (const move of moves) {
        const moved = await moveArchivedFile(move.id, move);
        if (!moved) {
          return NextResponse.json(
            { error: `文件不存在: ${move.id}` },
            { status: 404 }
          );
        }
        movedFiles.push(moved);
      }

      return NextResponse.json({
        success: true,
        movedCount: movedFiles.length,
        files: movedFiles,
      });
    }

    const { id, categoryId, categoryName, folderPath } = body;

    if (!id || !categoryId || !categoryName || !folderPath || !Array.isArray(folderPath)) {
      return NextResponse.json({ error: "缺少必要参数: id, categoryId, categoryName, folderPath" }, { status: 400 });
    }

    const result = await moveArchivedFile(id, { categoryId, categoryName, folderPath });
    if (!result) {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    return NextResponse.json({ success: true, file: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "移动文件失败" },
      { status: 500 }
    );
  }
}
