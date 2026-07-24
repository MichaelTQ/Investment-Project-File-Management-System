import { NextRequest, NextResponse } from "next/server";
import {
  createProject,
  listProjects,
  deleteProject,
} from "@/lib/storage";

// GET /api/projects - 获取项目列表
export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json({ projects });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取项目列表失败" },
      { status: 500 }
    );
  }
}

// POST /api/projects - 创建项目
export async function POST(request: NextRequest) {
  try {
    const { name, description } = await request.json();
    if (!name) {
      return NextResponse.json({ error: "项目名称不能为空" }, { status: 400 });
    }
    const project = await createProject(name, description ?? "");
    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建项目失败" },
      { status: 500 }
    );
  }
}

// DELETE /api/projects - 删除项目
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "缺少项目 ID" }, { status: 400 });
    }
    await deleteProject(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除项目失败" },
      { status: 500 }
    );
  }
}
