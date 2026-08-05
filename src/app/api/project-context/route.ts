import { NextRequest, NextResponse } from 'next/server';
import { HeaderUtils } from 'coze-coding-dev-sdk';

import { rebuildMinimalArchive } from '@/lib/classification/minimal/pipeline';
import { checkProjectConsistency } from '@/lib/classification/project-consistency';
import {
  getProjectContextMemoryView,
  rebuildProjectContext,
} from '@/lib/classification/session-project-memory';
import { getProject } from '@/lib/storage';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get('projectId')?.trim() ?? '';
    if (!projectId) {
      return NextResponse.json({ error: '缺少项目ID' }, { status: 400 });
    }
    if (!(await getProject(projectId))) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    }
    const [projectContext, consistency, minimal] = await Promise.all([
      getProjectContextMemoryView(projectId),
      checkProjectConsistency(projectId),
      rebuildMinimalArchive(projectId).catch(() => null),
    ]);
    return NextResponse.json({ projectContext, consistency, minimal });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : '读取项目Context失败',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    if (!projectId) {
      return NextResponse.json({ error: '缺少项目ID' }, { status: 400 });
    }
    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    }
    const projectContext = await rebuildProjectContext(projectId, {
      projectName: project.name,
      customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    // 重建之后立刻全量校验：新文件带来的交易记录可能回头推翻先前判过的文件。
    // 纯计算，不影响这次请求的耗时预算。
    const [consistency, minimal] = await Promise.all([
      checkProjectConsistency(projectId),
      rebuildMinimalArchive(projectId).catch(() => null),
    ]);
    return NextResponse.json({
      success: true,
      projectContext,
      consistency,
      minimal,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : '重建项目Context失败',
      },
      { status: 500 }
    );
  }
}
