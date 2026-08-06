import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { forgetMinimalDocument } from "@/lib/classification/minimal/store";
import {
  deleteStoredFile,
  getProject,
  uploadTemporaryFile,
} from "@/lib/storage";

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

// DELETE /api/uploads - 取消归档、分类失败或中断批量分析时清理临时对象。
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

    // 事实也要一起忘掉。调用方一直在传 sourcePath，但这里从来没用过它——于是
    // 取消归档、中断批量分析之后，这份文件的事实仍留在项目档案里，继续作为
    // "同项目其他文件"参与后续判断，还会进时间线。用户以为撤销了，其实没有。
    if (sourcePath) {
      await forgetMinimalDocument(projectId, sourcePath).catch(error => {
        // 事实没删掉不该让临时文件的清理跟着失败——那样会同时留下两份垃圾。
        console.error("Forget minimal document error:", error);
      });
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
