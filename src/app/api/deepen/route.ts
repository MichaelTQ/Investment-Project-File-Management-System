import { HeaderUtils } from 'coze-coding-dev-sdk';
import { NextRequest, NextResponse } from 'next/server';

import {
  describeDeepenFlag,
  isDeepenEnabled,
  runDeepen,
} from '@/lib/classification/deepen/agent';
import { matchSpecTerm } from '@/lib/classification/naming-spec';
import { getProject } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * POST /api/deepen —— 对某一份文件发起深挖。
 *
 * 只读接口：跑完不写任何东西，产出是一份建议 + 完整执行轨迹，照旧要人工确认。
 * 默认关闭，`ENABLE_DEEPEN_AGENT=true` 才启用。
 *
 * 为什么单独一个接口而不是塞进 /api/classify：那个接口服务上传流程，一次请求
 * 一份文件、步骤固定；深挖是按需触发、步数不定、可能跑几十秒。混在一起的话，
 * 上传链路会被迫背上深挖的超时和预算配置。
 */
export async function POST(request: NextRequest) {
  try {
    if (!isDeepenEnabled()) {
      // 把服务端实际读到的值一并返回。"没设"和"设了但服务进程没看见"是两种完全
      // 不同的毛病，只说一句"未启用"会让人反复确认自己明明设过了。
      return NextResponse.json(
        {
          error: `深挖功能未启用。需要 ENABLE_DEEPEN_AGENT=true，当前${describeDeepenFlag()}。注意变量要在**启动服务的那个进程**里，改完要重启服务。`,
        },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => null);
    const projectId =
      typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    const sourcePath =
      typeof body?.sourcePath === 'string' ? body.sourcePath.trim() : '';

    if (!projectId || !sourcePath) {
      return NextResponse.json(
        { error: '需要 projectId 和 sourcePath' },
        { status: 400 }
      );
    }

    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    }

    // 命名规范词条由前端透传（它在批量分流那步已经算过），这里只查表得出候选阶段。
    // 前端不参与"哪个词条属于哪个阶段"的判断。
    const matched =
      typeof body?.namingTerm === 'string'
        ? matchSpecTerm(body.namingTerm)
        : null;

    const result = await runDeepen({
      projectId,
      sourcePath,
      projectName: project.name,
      projectNotes: project.description,
      namingHint:
        matched?.term && matched.stages.length > 0
          ? { term: matched.term, stages: matched.stages }
          : undefined,
      customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });

    return NextResponse.json({ deepen: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '深挖失败' },
      { status: 500 }
    );
  }
}
