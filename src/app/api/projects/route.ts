import { NextRequest, NextResponse } from 'next/server';
import { getProjects, createProject, deleteProject } from '@/lib/storage';

export const runtime = 'nodejs';

// GET - 获取所有项目
export async function GET() {
  try {
    const projects = getProjects();
    return NextResponse.json({ projects });
  } catch (error) {
    return NextResponse.json(
      { error: '获取项目列表失败', details: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}

// POST - 创建项目
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: '项目名称不能为空' },
        { status: 400 }
      );
    }

    const project = createProject(name.trim(), description?.trim());
    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json(
      { error: '创建项目失败', details: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}

// DELETE - 删除项目
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: '缺少项目 ID' },
        { status: 400 }
      );
    }

    const success = deleteProject(id);
    if (!success) {
      return NextResponse.json(
        { error: '项目不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: '删除项目失败', details: error instanceof Error ? error.message : '未知错误' },
      { status: 500 }
    );
  }
}
