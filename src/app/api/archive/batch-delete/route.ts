import { NextRequest, NextResponse } from "next/server";
import { deleteArchivedFile } from "@/lib/storage";
import { forgetProjectDocumentsByFileName } from "@/lib/classification/session-project-memory";

export const runtime = "nodejs";

// POST /api/archive/batch-delete - 批量删除归档文件
// 使用 POST，避免部分代理丢弃 DELETE 请求体。
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const rawIds: unknown[] = Array.isArray(body?.ids) ? body.ids : [];
    const ids: string[] = rawIds.filter(
          (item: unknown): item is string =>
            typeof item === "string" && item.trim().length > 0
        );
    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length === 0) {
      return NextResponse.json(
        { error: "缺少要删除的文件 ID" },
        { status: 400 }
      );
    }

    for (const fileId of uniqueIds) {
      const deleted = await deleteArchivedFile(fileId);
      if (deleted) {
        try {
          await forgetProjectDocumentsByFileName(
            deleted.projectId,
            deleted.originalName
          );
        } catch (memoryError) {
          console.error('Batch delete memory cleanup failed:', memoryError);
        }
      }
    }

    return NextResponse.json({
      success: true,
      deletedCount: uniqueIds.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "批量删除归档文件失败",
      },
      { status: 500 }
    );
  }
}
