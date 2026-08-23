import { HeaderUtils } from 'coze-coding-dev-sdk';
import { NextRequest, NextResponse } from 'next/server';

import {
  describeDeepenFlag,
  isDeepenEnabled,
  runDeepen,
} from '@/lib/classification/deepen/agent';
import type { DeepenOrchestrator } from '@/lib/classification/deepen/types';
import { matchSpecTerm } from '@/lib/classification/naming-spec';
import { getProject } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * POST /api/deepen —— 对某一份文件发起深挖。
 *
 * 只读接口：跑完不写任何东西，产出是一份建议 + 完整执行轨迹，照旧要人工确认。
 * 默认开启，`DISABLE_DEEPEN_AGENT=true` 可关掉。
 *
 * 编排方式可由 body.orchestrator 指定（loop / graph），不传走服务端默认。
 *
 * 为什么单独一个接口而不是塞进 /api/classify：那个接口服务上传流程，一次请求
 * 一份文件、步骤固定；深挖是按需触发、步数不定、可能跑几十秒。混在一起的话，
 * 上传链路会被迫背上深挖的超时和预算配置。
 */
export async function POST(request: NextRequest) {
  try {
    // 默认开启，只有被显式关掉才会走到这里。
    if (!isDeepenEnabled()) {
      return NextResponse.json(
        {
          error: `深挖功能已被关闭（${describeDeepenFlag()}）。去掉 DISABLE_DEEPEN_AGENT 或把 ENABLE_DEEPEN_AGENT 设回 true 即可，改完要重启服务。`,
        },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => null);
    const projectId =
      typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    const sourcePath =
      typeof body?.sourcePath === 'string' ? body.sourcePath.trim() : '';
    // 编排方式由前端可选透传。认不出来的值当没传，走服务端默认——绝不因为一个拼错的
    // 字符串把请求打回去，这个参数只影响控制流，不影响结论。
    const orchestrator: DeepenOrchestrator | undefined =
      body?.orchestrator === 'graph' || body?.orchestrator === 'loop'
        ? body.orchestrator
        : undefined;

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
      orchestrator,
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
