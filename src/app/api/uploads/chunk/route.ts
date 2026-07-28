import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { getProject, uploadTemporaryFile } from "@/lib/storage";

export const runtime = "nodejs";

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk

// 内存中暂存分片，uploadId → { chunks, fileName, mimeType, projectId, total, received }
const sessions = new Map<string, {
  chunks: Map<number, Buffer>;
  fileName: string;
  mimeType: string;
  projectId: string;
  total: number;
  received: number;
  createdAt: number;
}>();

// 每 5 分钟清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}, 60 * 1000);

// PUT /api/uploads/chunk - 分片上传
export async function PUT(request: NextRequest) {
  try {
    const uploadId = request.headers.get("x-upload-id")?.trim() || "";
    const chunkIndex = Number(request.headers.get("x-chunk-index") || "-1");
    const chunkTotal = Number(request.headers.get("x-chunk-total") || "0");
    const projectId = request.headers.get("x-project-id")?.trim() || "";
    const encodedFileName = request.headers.get("x-file-name") || "";
    const mimeType = request.headers.get("content-type") || "application/octet-stream";

    let fileName = "";
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      fileName = encodedFileName;
    }

    if (!uploadId || chunkIndex < 0 || !chunkTotal || !projectId || !fileName || !request.body) {
      return NextResponse.json(
        { error: "缺少必要参数：uploadId, chunkIndex, chunkTotal, projectId, fileName" },
        { status: 400 }
      );
    }

    if (!(await getProject(projectId))) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    // 读取分片数据
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalBytes += value.length;
      }
    }
    const chunkData = Buffer.concat(chunks);

    // 初始化或获取会话
    let session = sessions.get(uploadId);
    if (!session) {
      session = {
        chunks: new Map(),
        fileName,
        mimeType,
        projectId,
        total: chunkTotal,
        received: 0,
        createdAt: Date.now(),
      };
      sessions.set(uploadId, session);
    }

    // 存储分片
    session.chunks.set(chunkIndex, chunkData);
    session.received++;

    // 检查是否全部收齐
    if (session.received < session.total) {
      return NextResponse.json({
        uploaded: session.received,
        total: session.total,
        complete: false,
      });
    }

    // 全部收齐，组装并上传 S3
    const orderedChunks: Buffer[] = [];
    for (let i = 0; i < session.total; i++) {
      const c = session.chunks.get(i);
      if (!c) {
        sessions.delete(uploadId);
        return NextResponse.json(
          { error: `缺少分片 ${i}，上传不完整` },
          { status: 400 }
        );
      }
      orderedChunks.push(c);
    }
    const fullBuffer = Buffer.concat(orderedChunks);

    // 清理会话
    sessions.delete(uploadId);

    // 上传到 S3
    const storageKey = await uploadTemporaryFile({
      stream: Readable.from(fullBuffer),
      fileName,
      mimeType,
      projectId,
    });

    return NextResponse.json({
      uploaded: session.total,
      total: session.total,
      complete: true,
      storageKey,
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
