import { NextRequest, NextResponse } from 'next/server';
import { HeaderUtils } from 'coze-coding-dev-sdk';

import { matchSpecTerm } from '@/lib/classification/naming-spec';
import {
  decideStagesForBatchWithModel,
  type BatchStageDecisionItem,
} from '@/lib/classification/llm-stage-decision';
import {
  buildTimeline,
  describeTimeline,
} from '@/lib/classification/minimal/evidence';
import type { MinimalClassifyResult } from '@/lib/classification/minimal/pipeline';
import { loadMinimalArchive } from '@/lib/classification/minimal/store';
import { getProject } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * POST /api/decide —— 整批一次判阶段。
 *
 * 逐份判断（/api/classify mode=decide）每次都要重发同项目其他文件的事实和整条时间线，
 * 17 份文件就是 17 次调用、每次驮着 17 份的上下文。这里把上下文只发一遍，一次拿回
 * 全部结论。
 *
 * 失败时返回 decisions 全 null，由前端退回逐份判断——风险集中是这条路的代价，
 * 兜底必须留着。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const sourcePaths: string[] = Array.isArray(body.sourcePaths)
      ? body.sourcePaths.filter(
          (item: unknown): item is string => typeof item === 'string'
        )
      : [];
    const namingTerms: Array<string | null> = Array.isArray(body.namingTerms)
      ? body.namingTerms
      : [];

    if (!projectId || sourcePaths.length === 0) {
      return NextResponse.json(
        { error: '需要 projectId 和至少一个 sourcePath' },
        { status: 400 }
      );
    }

    const [archive, project] = await Promise.all([
      loadMinimalArchive(projectId),
      getProject(projectId),
    ]);
    const byPath = new Map(
      archive.documents.map(document => [document.sourcePath, document])
    );

    const items: BatchStageDecisionItem[] = [];
    const resolvedPaths: string[] = [];
    const missing: string[] = [];
    for (const [index, sourcePath] of sourcePaths.entries()) {
      const stored = byPath.get(sourcePath);
      if (!stored) {
        missing.push(sourcePath);
        continue;
      }
      const matched = matchSpecTerm(namingTerms[index]);
      items.push({
        sourcePath,
        facts: stored.facts,
        namingHint:
          matched.term && matched.stages.length > 0
            ? { term: matched.term, stages: matched.stages }
            : undefined,
      });
      resolvedPaths.push(sourcePath);
    }

    if (items.length === 0) {
      return NextResponse.json(
        { error: '这批文件都没有已抽取的事实，请重新上传' },
        { status: 409 }
      );
    }

    // 背景：本项目里**不在这一批**的已归档文件。时间线仍然用全量，
    // 因为判断先后要看完整的项目脉络。
    const inBatch = new Set(resolvedPaths);
    const archivedDocuments = archive.documents
      .filter(document => document.stage && !inBatch.has(document.sourcePath))
      .map(document => ({
        sourcePath: document.sourcePath,
        facts: document.facts,
      }));

    const startedAt = Date.now();
    const result = await decideStagesForBatchWithModel({
      items,
      projectName: project?.name,
      archivedDocuments,
      timeline: describeTimeline(buildTimeline(archive.documents), {
        showStage: true,
      }),
      customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });

    const decided = result.decisions.filter(Boolean).length;
    console.log(
      `[decide] ${items.length} 份文件一次判完：拿到结论 ${decided} 份，耗时 ${(
        (Date.now() - startedAt) / 1000
      ).toFixed(1)}s`
    );

    return NextResponse.json({
      status: result.status,
      // 按传入的 sourcePaths 原样对齐，缺事实的位置补 null，前端不必再对表。
      results: sourcePaths.map(sourcePath => {
        const index = resolvedPaths.indexOf(sourcePath);
        const decision = index >= 0 ? result.decisions[index] : null;
        return {
          sourcePath,
          // 必须转成与逐份判断（classifyWithMinimalPath）一致的字段名。
          // 内部结构用的是 selectedFolder / businessStage，前端读的是 folder / stage，
          // 直接把内部结构丢出去的话每一份都会变成"没有归档位置"，而且不报错——
          // 界面只会显示"暂未形成唯一分类建议"，看不出是字段名对不上。
          decision: decision
            ? ({
                sourcePath,
                stage: decision.businessStage,
                folder: decision.selectedFolder,
                reasoning: decision.reasoning,
                evidence: decision.evidence,
                contradictions: decision.contradictions,
                requiresHumanReview: decision.requiresHumanReview,
                status: 'success',
                // 标上类型，让编译器守住这个边界。之前这里直接把内部结构丢出去，
                // 字段名对不上却一路静默传到界面，只表现为"暂未形成唯一分类建议"。
              } satisfies MinimalClassifyResult)
            : null,
        };
      }),
      missing,
      error: result.error,
      modelCall: result.modelCall,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('Decide route error:', error);
    return NextResponse.json(
      {
        error: '整批阶段判断失败',
        details: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    );
  }
}
