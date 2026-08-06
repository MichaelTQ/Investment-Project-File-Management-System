import { NextRequest, NextResponse } from 'next/server';
import { HeaderUtils } from 'coze-coding-dev-sdk';

import { normalizeFilenamesWithModel } from '@/lib/classification/filename-normalizer';
import {
  listAmbiguousTerms,
  matchSpecTerm,
  type NamingMatch,
} from '@/lib/classification/naming-spec';

export const runtime = 'nodejs';

/** 一次最多归一多少个文件名。超过就分批，避免输出撞上 token 上限被截断。 */
const MAX_NAMES_PER_REQUEST = 200;

export interface NamingRouteResult extends NamingMatch {
  sourcePath: string;
}

/**
 * POST /api/naming —— 批量文件名分流。
 *
 * 整批只调一次模型：模型把文件名归一到客户规范里的词条，词条到阶段的映射由代码里
 * 数出来的表决定。模型全程不输出阶段，理由见 filename-normalizer.ts。
 *
 * 这一步失败不会卡住流程：归一化返回全 null，所有文件按"未命中"处理，也就是回到
 * 没有这一步之前的完整事实链路。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sourcePaths: string[] = Array.isArray(body.sourcePaths)
      ? body.sourcePaths
          .filter((item: unknown): item is string => typeof item === 'string')
          .slice(0, MAX_NAMES_PER_REQUEST)
      : [];

    if (sourcePaths.length === 0) {
      return NextResponse.json({ error: '未提供文件名' }, { status: 400 });
    }

    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
    const normalized = await normalizeFilenamesWithModel({
      sourcePaths,
      customHeaders,
    });

    const results: NamingRouteResult[] = sourcePaths.map((sourcePath, index) => ({
      sourcePath,
      ...matchSpecTerm(normalized.terms[index]),
    }));

    const counts = results.reduce(
      (acc, item) => ({ ...acc, [item.kind]: acc[item.kind] + 1 }),
      { unique: 0, ambiguous: 0, unmatched: 0 }
    );
    console.log(
      `[naming] ${sourcePaths.length} 个文件：唯一命中 ${counts.unique}，歧义 ${counts.ambiguous}，未命中 ${counts.unmatched}`
    );
    // 逐份打印归一结果。只看汇总数分不清"规范没覆盖"和"模型该认的没认出来"——
    // 后者才是要修的，而它恰恰是这套方案最大的风险点（模型倾向于给答案，
    // 提示词里那句"对不上就答无"到底管不管用，只有看逐份结果才知道）。
    for (const item of results) {
      const leaf = item.sourcePath.split(/[/\\]/).pop() ?? item.sourcePath;
      console.log(
        `[naming]   ${leaf} → ${
          item.term ?? '无'
        }（${item.kind}${item.stages.length > 0 ? '：' + item.stages.join('、') : ''}）`
      );
    }

    return NextResponse.json({
      results,
      counts,
      status: normalized.status,
      error: normalized.error,
      modelCall: normalized.modelCall,
    });
  } catch (error) {
    console.error('Naming route error:', error);
    return NextResponse.json(
      {
        error: '文件名分流失败',
        details: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    );
  }
}

/** GET /api/naming —— 返回规范里跨阶段的词条，界面用来说明为什么某些文件要读内容。 */
export async function GET() {
  return NextResponse.json({ ambiguousTerms: listAmbiguousTerms() });
}
