import { NextRequest, NextResponse } from 'next/server';
import { HeaderUtils } from 'coze-coding-dev-sdk';

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
    return NextResponse.json({
      projectContext: await getProjectContextMemoryView(projectId),
    });
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
    return NextResponse.json({ success: true, projectContext });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : '重建项目Context失败',
      },
      { status: 500 }
    );
  }
}
