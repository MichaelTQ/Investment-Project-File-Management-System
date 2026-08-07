import { HeaderUtils } from 'coze-coding-dev-sdk';
import { NextRequest, NextResponse } from 'next/server';
import { rebuildMinimalArchive } from '@/lib/classification/minimal/pipeline';
import { clearMinimalArchive } from '@/lib/classification/minimal/store';
import { getProject } from '@/lib/storage';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get('projectId')?.trim() ?? '';
    if (!projectId) {
      return NextResponse.json({ error: '缺少项目ID' }, { status: 400 });
    }
    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    }
    // 纯读取：返回各文件的事实与时间线，不跑冲突复核。
    // 复核要调模型，而这个接口在切换项目、刷新页面时都会被调用。
    const minimal = await rebuildMinimalArchive(projectId, {
      projectName: project.name,
      reviewConflicts: false,
    });
    return NextResponse.json({ minimal, consistency: minimal });
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
    const minimal = await rebuildMinimalArchive(projectId, {
      projectName: project.name,
      customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    return NextResponse.json({
      success: true,
      consistency: minimal,
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

/**
 * DELETE /api/project-context?projectId=xxx&scope=minimal
 * 清空项目事实表。归档文件删除后事实会同步清理，这个接口用于重跑测试，
 * 或修复历史遗留的孤立条目（删除流程接入之前产生的）。
 */
export async function DELETE(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get('projectId')?.trim() ?? '';
    const scope = request.nextUrl.searchParams.get('scope') ?? 'minimal';
    if (!projectId) {
      return NextResponse.json({ error: '缺少项目ID' }, { status: 400 });
    }
    if (scope !== 'minimal') {
      return NextResponse.json(
        { error: '仅支持 scope=minimal' },
        { status: 400 }
      );
    }
    if (!(await getProject(projectId))) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    }
    const removedCount = await clearMinimalArchive(projectId);
    return NextResponse.json({
      success: true,
      removedCount,
      minimal: await rebuildMinimalArchive(projectId),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : '清空项目事实表失败',
      },
      { status: 500 }
    );
  }
}
