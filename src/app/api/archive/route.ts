import { NextRequest, NextResponse } from "next/server";
import { HeaderUtils } from "coze-coding-dev-sdk";
import {
  listArchivedFiles,
  deleteArchivedFile,
  moveArchivedFile,
  renameArchivedFile,
  renameArchivedFolder,
  getFileDownloadUrl,
  getFileDownloadStream,
  buildArchiveTree,
  archiveFile,
  archiveStoredFile,
  getProject,
  type ArchivedFile,
} from "@/lib/storage";
import { getArchiveFolder } from "@/lib/folder-structure";
import { DocumentFactsSchema, type DocumentFacts } from "@/lib/classification/document-facts";
import {
  commitArchivedProjectDocument,
  forgetProjectDocumentByArchivedFileId,
  forgetProjectDocumentsByFileName,
  markProjectContextDirty,
} from "@/lib/classification/session-project-memory";
import { forgetMinimalDocumentsByArchivedFile } from "@/lib/classification/minimal/store";

export const runtime = "nodejs";

// POST /api/archive - 用户确认 AI 建议名称后归档文件
export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();
  const phaseTimings: Array<{ phase: string; durationMs: number }> = [];
  const measurePhase = async <T>(phase: string, action: () => Promise<T>) => {
    const startedAt = Date.now();
    try {
      return await action();
    } finally {
      phaseTimings.push({ phase, durationMs: Date.now() - startedAt });
    }
  };
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
    let folderId = "";
    let archiveTitle = "";
    let reasoning = "";
    let parsedConfidence = 0;
    let folderPath: string[] = [];
    let sourcePath = "";
    let documentFacts: DocumentFacts | null = null;

    if (isJsonRequest) {
      const body = await request.json();
      storageKey = String(body.storageKey || "");
      originalName = String(body.originalName || "");
      fileSize = Number(body.fileSize || 0);
      mimeType = String(body.mimeType || mimeType);
      projectId = String(body.projectId || "");
      folderId = String(body.folderId || "");
      archiveTitle = String(body.archiveTitle || "").trim();
      reasoning = String(body.reasoning || "");
      parsedConfidence = Number(body.confidence || 0);
      sourcePath = String(body.sourcePath || originalName);
      const parsedFacts = DocumentFactsSchema.safeParse(body.documentFacts);
      documentFacts = parsedFacts.success ? parsedFacts.data : null;
    } else {
      const formData = await request.formData();
      const formFile = formData.get("file");
      file = formFile instanceof File ? formFile : null;
      originalName = file?.name || "";
      fileSize = file?.size || 0;
      mimeType = file?.type || mimeType;
      projectId = String(formData.get("projectId") ?? "");
      folderId = String(formData.get("folderId") ?? "");
      archiveTitle = String(formData.get("archiveTitle") ?? "").trim();
      reasoning = String(formData.get("reasoning") ?? "");
      parsedConfidence = Number(formData.get("confidence") ?? 0);
      sourcePath = String(formData.get("sourcePath") ?? originalName);
      try {
        const parsedFacts = DocumentFactsSchema.safeParse(
          JSON.parse(String(formData.get("documentFacts") ?? "null"))
        );
        documentFacts = parsedFacts.success ? parsedFacts.data : null;
      } catch {
        documentFacts = null;
      }

    }

    if (
      (!file && !storageKey) ||
      !originalName ||
      !projectId ||
      !folderId
    ) {
      return NextResponse.json(
        { error: "缺少文件、项目或目标文件夹信息" },
        { status: 400 }
      );
    }
    if (storageKey && !storageKey.startsWith(`uploads/${projectId}/`)) {
      return NextResponse.json({ error: "无效的 S3 临时文件地址" }, { status: 400 });
    }

    const targetFolder = getArchiveFolder(folderId);
    if (!targetFolder) {
      return NextResponse.json({ error: "无效的目标文件夹" }, { status: 400 });
    }
    folderPath = targetFolder.folderPath;

    const project = await measurePhase("load_project", () => getProject(projectId));
    if (!project) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const confidence = Number.isFinite(parsedConfidence)
      ? Math.max(0, Math.min(100, Math.round(parsedConfidence)))
      : 0;
    const archived = await measurePhase("archive_file", async () =>
      storageKey
      ? archiveStoredFile({
          storageKey,
          originalName,
          fileSize,
          projectId,
          projectName: project.name,
          folderId: targetFolder.folderId,
          folderPath,
          mimeType,
          confidence,
          reasoning,
          archiveTitle,
        })
      : archiveFile({
          fileBuffer: Buffer.from(await file!.arrayBuffer()),
          originalName,
          projectId,
          projectName: project.name,
          folderId: targetFolder.folderId,
          folderPath,
          mimeType,
          confidence,
          reasoning,
          archiveTitle,
        })
    );

    let projectContext;
    try {
      if (documentFacts) {
        const factsToCommit = documentFacts;
        const committed = await measurePhase(
          "commit_context_pending",
          () => commitArchivedProjectDocument({
            projectId,
            projectName: project.name,
            sourcePath: sourcePath || originalName,
            facts: factsToCommit,
            archivedFileId: archived.id,
            customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
            deferContextRebuild: true,
          })
        );
        const { currentDecision: _currentDecision, ...view } = committed;
        void _currentDecision;
        projectContext = view;
      } else {
        projectContext = await markProjectContextDirty(
          projectId,
          `文件“${originalName}”已归档，但缺少可提交的结构化事实`
        );
      }
    } catch (contextError) {
      console.error('Archive Context commit failed:', contextError);
    }

    return NextResponse.json({
      success: true,
      archived: {
        id: archived.id,
        archivedName: archived.archivedName,
        projectName: archived.projectName,
        folderPath: archived.folderPath,
      },
      projectContext,
      contextRebuildPending: Boolean(documentFacts && projectContext),
      performance: {
        totalDurationMs: Date.now() - requestStartedAt,
        phases: phaseTimings,
        modelCalls: projectContext?.contextSynthesis?.modelCalls ?? [],
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
      const deleted = await deleteArchivedFile(fileId);
      if (deleted) {
        try {
          const removed = await forgetProjectDocumentByArchivedFileId(
            deleted.projectId,
            deleted.archivedFileId,
            {
              customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
            }
          );
          if (!removed && deleted.originalName) {
            await forgetProjectDocumentsByFileName(
              deleted.projectId,
              deleted.originalName,
              {
                customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
              }
            );
          }
        } catch (memoryError) {
          console.error('Delete archive memory cleanup failed:', memoryError);
        }
        try {
          // 极简链路有自己的事实表，删除必须同步，否则事实会继续参与后续判断。
          await forgetMinimalDocumentsByArchivedFile(deleted.projectId, {
            archivedFileId: deleted.archivedFileId,
            originalName: deleted.originalName,
          });
        } catch (minimalError) {
          console.error('Minimal archive cleanup failed:', minimalError);
        }
      }
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
    if (body.action === "rename-file") {
      const id = typeof body.id === "string" ? body.id : "";
      const newTitle =
        typeof body.newTitle === "string" ? body.newTitle.trim() : "";
      if (!id || !newTitle) {
        return NextResponse.json(
          { error: "缺少文件 ID 或新名称" },
          { status: 400 }
        );
      }

      const file = await renameArchivedFile(id, newTitle);
      if (!file) {
        return NextResponse.json({ error: "文件不存在" }, { status: 404 });
      }
      return NextResponse.json({ success: true, file });
    }

    if (body.action === "rename-folder") {
      const projectId =
        typeof body.projectId === "string" ? body.projectId : "";
      const sourcePath = Array.isArray(body.sourcePath)
        ? body.sourcePath.filter(
            (segment: unknown): segment is string =>
              typeof segment === "string"
          )
        : [];
      const newName =
        typeof body.newName === "string" ? body.newName.trim() : "";
      if (!projectId || sourcePath.length === 0 || !newName) {
        return NextResponse.json(
          { error: "缺少项目、原文件夹路径或新名称" },
          { status: 400 }
        );
      }

      const updatedCount = await renameArchivedFolder({
        projectId,
        sourcePath,
        newName,
      });
      return NextResponse.json({ success: true, updatedCount });
    }

    if (Array.isArray(body.moves)) {
      const moves = body.moves.filter(
        (move: unknown): move is {
          id: string;
          folderId: string;
          folderPath: string[];
        } => {
          if (!move || typeof move !== "object") return false;
          const item = move as Record<string, unknown>;
          return (
            typeof item.id === "string" &&
            typeof item.folderId === "string" &&
            Array.isArray(item.folderPath) &&
            item.folderPath.every(segment => typeof segment === "string")
          );
        }
      );

      if (moves.length === 0 || moves.length !== body.moves.length) {
        return NextResponse.json({ error: "批量移动参数格式错误" }, { status: 400 });
      }

      const movedFiles: ArchivedFile[] = [];
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
      const projectContexts = await Promise.all(
        [...new Set(movedFiles.map(file => file.projectId))].map(projectId =>
          markProjectContextDirty(
            projectId,
            `人工移动了 ${movedFiles.filter(file => file.projectId === projectId).length} 份归档文件`
          ).catch(error => {
            console.error('Mark moved files Context dirty failed:', error);
            return null;
          })
        )
      );

      return NextResponse.json({
        success: true,
        movedCount: movedFiles.length,
        files: movedFiles,
        projectContexts: projectContexts.filter(Boolean),
      });
    }

    const { id, folderId, folderPath } = body;

    if (!id || !folderId || !folderPath || !Array.isArray(folderPath)) {
      return NextResponse.json({ error: "缺少必要参数: id, folderId, folderPath" }, { status: 400 });
    }

    const result = await moveArchivedFile(id, { folderId, folderPath });
    if (!result) {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    const projectContext = await markProjectContextDirty(
      result.projectId,
      `人工移动了归档文件“${result.originalName}”`
    ).catch(error => {
      console.error('Mark moved file Context dirty failed:', error);
      return null;
    });

    return NextResponse.json({ success: true, file: result, projectContext });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "移动文件失败" },
      { status: 500 }
    );
  }
}
