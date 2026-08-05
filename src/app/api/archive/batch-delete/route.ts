import { NextRequest, NextResponse } from "next/server";
import { HeaderUtils } from "coze-coding-dev-sdk";
import { deleteArchivedFile } from "@/lib/storage";
import {
  forgetProjectDocumentByArchivedFileId,
  forgetProjectDocumentsByFileName,
} from "@/lib/classification/session-project-memory";
import { forgetMinimalDocumentsByArchivedFile } from "@/lib/classification/minimal/store";

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
          const removed = await forgetProjectDocumentByArchivedFileId(
            deleted.projectId,
            deleted.archivedFileId,
            {
              customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
            }
          );
          // 旧数据可能缺少 archivedFileId 关联，降级按文件名匹配
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
          console.error('Batch delete memory cleanup failed:', memoryError);
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
