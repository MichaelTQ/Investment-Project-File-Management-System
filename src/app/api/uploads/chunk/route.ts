import { NextRequest, NextResponse } from "next/server";
import {
  combineTemporaryChunks,
  deleteStoredFilesByPrefix,
  getProject,
  uploadTemporaryChunk,
} from "@/lib/storage";

export const runtime = "nodejs";

const CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE);
const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/i;

function getChunkPrefix(projectId: string, uploadId: string) {
  return `upload-chunks/${projectId}/${uploadId}/`;
}

function isValidUploadId(uploadId: string) {
  return UPLOAD_ID_RE.test(uploadId);
}

// PUT /api/uploads/chunk - 每个分片收到后立即写入 S3，不保存服务器内存状态。
export async function PUT(request: NextRequest) {
  try {
    const uploadId = request.headers.get("x-upload-id")?.trim() || "";
    const chunkIndex = Number(request.headers.get("x-chunk-index") || "-1");
    const chunkTotal = Number(request.headers.get("x-chunk-total") || "0");
    const projectId = request.headers.get("x-project-id")?.trim() || "";

    if (
      !isValidUploadId(uploadId) ||
      !projectId ||
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(chunkTotal) ||
      chunkIndex < 0 ||
      chunkTotal < 1 ||
      chunkTotal > MAX_CHUNKS ||
      chunkIndex >= chunkTotal ||
      !request.body
    ) {
      return NextResponse.json(
        { error: "分片参数无效或文件超过 100 MB" },
        { status: 400 }
      );
    }
    if (!(await getProject(projectId))) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.length === 0 || buffer.length > CHUNK_SIZE) {
      return NextResponse.json(
        { error: "单个分片必须在 1 字节至 2 MB 之间" },
        { status: 413 }
      );
    }

    const chunkKey = await uploadTemporaryChunk({
      buffer,
      projectId,
      uploadId,
      chunkIndex,
    });

    return NextResponse.json({
      chunkIndex,
      chunkTotal,
      chunkKey,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "分片上传失败",
      },
      { status: 500 }
    );
  }
}

// POST /api/uploads/chunk - 合并分片，或清理一次未完成的上传。
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action === "abort" ? "abort" : "complete";
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    const prefix = getChunkPrefix(projectId, uploadId);

    if (!isValidUploadId(uploadId) || !projectId) {
      return NextResponse.json({ error: "上传编号或项目无效" }, { status: 400 });
    }

    if (action === "abort") {
      await deleteStoredFilesByPrefix(prefix);
      return NextResponse.json({ success: true });
    }

    const encodedFileName =
      typeof body.fileName === "string" ? body.fileName : "";
    const mimeType =
      typeof body.mimeType === "string" && body.mimeType
        ? body.mimeType
        : "application/octet-stream";
    const rawChunkKeys: unknown[] = Array.isArray(body.chunkKeys)
      ? body.chunkKeys
      : [];
    const chunkKeys: string[] = rawChunkKeys.filter(
      (key: unknown): key is string => typeof key === "string"
    );

    let fileName = "";
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      fileName = encodedFileName;
    }

    if (
      !fileName ||
      chunkKeys.length < 1 ||
      chunkKeys.length > MAX_CHUNKS ||
      new Set(chunkKeys).size !== chunkKeys.length ||
      chunkKeys.some((key, index) =>
        !key.startsWith(prefix) ||
        !key.slice(prefix.length).startsWith(`chunk-${index}_`)
      )
    ) {
      return NextResponse.json(
        { error: "合并参数无效、分片重复或分片不属于本次上传" },
        { status: 400 }
      );
    }
    if (!(await getProject(projectId))) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const storageKey = await combineTemporaryChunks({
      chunkKeys,
      fileName,
      mimeType,
      projectId,
    });

    try {
      await deleteStoredFilesByPrefix(prefix);
    } catch (cleanupError) {
      // 最终文件已经生成，清理失败不应让客户端误以为合并失败并重复上传。
      console.error("Temporary chunk cleanup error:", cleanupError);
    }
    return NextResponse.json({ storageKey });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "合并分片失败",
      },
      { status: 500 }
    );
  }
}
