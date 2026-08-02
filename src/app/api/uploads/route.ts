import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { HeaderUtils } from "coze-coding-dev-sdk";
import {
  deleteStoredFile,
  getProject,
  uploadTemporaryFile,
} from "@/lib/storage";
import { forgetProjectDocument } from "@/lib/classification/session-project-memory";

export const runtime = "nodejs";

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

async function* readRequestBody(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

// POST /api/uploads - 只负责将原始文件流写入 S3，不做解析和 AI 分析。
export async function POST(request: NextRequest) {
  try {
    const projectId = request.headers.get("x-project-id")?.trim() || "";
    const encodedFileName = request.headers.get("x-file-name") || "";
    const mimeType =
      request.headers.get("content-type") || "application/octet-stream";
    const declaredSize = Number(request.headers.get("content-length") || 0);

    let fileName = "";
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      fileName = encodedFileName;
    }

    if (!projectId || !fileName || !request.body) {
      return NextResponse.json(
        { error: "缺少项目、文件名或文件内容" },
        { status: 400 }
      );
    }
    if (declaredSize > MAX_UPLOAD_SIZE) {
      return NextResponse.json(
        { error: "单个文件不能超过 100 MB" },
        { status: 413 }
      );
    }
    if (!(await getProject(projectId))) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const storageKey = await uploadTemporaryFile({
      stream: Readable.from(readRequestBody(request.body)),
      fileName,
      mimeType,
      projectId,
    });

    return NextResponse.json({ storageKey });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "上传文件到 S3 失败",
      },
      { status: 500 }
    );
  }
}

// DELETE /api/uploads - 取消归档或分类失败时清理临时对象。
export async function DELETE(request: NextRequest) {
  try {
    const storageKey = request.nextUrl.searchParams.get("storageKey") || "";
    const projectId = request.nextUrl.searchParams.get("projectId") || "";
    const sourcePath = request.nextUrl.searchParams.get("sourcePath") || "";
    const expectedPrefix = `uploads/${projectId}/`;

    if (!storageKey || !projectId || !storageKey.startsWith(expectedPrefix)) {
      return NextResponse.json({ error: "无效的临时文件地址" }, { status: 400 });
    }

    await deleteStoredFile(storageKey);
    if (sourcePath) {
      try {
        const project = await getProject(projectId);
        await forgetProjectDocument(projectId, sourcePath, {
          projectName: project?.name,
          customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
        });
      } catch (memoryError) {
        // 文件已经清理成功；项目记忆刷新失败不能把本次删除误报为失败。
        console.error('Temporary upload memory cleanup failed:', memoryError);
      }
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "清理临时文件失败",
      },
      { status: 500 }
    );
  }
}
