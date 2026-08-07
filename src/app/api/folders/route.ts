import { NextRequest, NextResponse } from 'next/server';
import { HeaderUtils } from 'coze-coding-dev-sdk';

import {
  classifyFoldersWithModel,
  matchStageByFolderName,
} from '@/lib/classification/folder-stage';
import type { ArchiveBusinessStage } from '@/lib/folder-structure';
import { getProject } from '@/lib/storage';

export const runtime = 'nodejs';

const MAX_FOLDERS_PER_REQUEST = 200;

export interface FolderStageRouteResult {
  name: string;
  stage: ArchiveBusinessStage | null;
  /** exact 表示文件夹名精确等于阶段名，没有调模型。 */
  source: 'exact' | 'model' | 'none';
}

/**
 * POST /api/folders —— 批量判断顶层文件夹属于哪个阶段。
 *
 * 精确命中阶段名的先摘出去不调模型；剩下的整批一次交给模型。判不出的返回 stage=null，
 * 前端把它放进「未能区分」，由人工分类或取消归档。**不往下看子层级**。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const folderNames: string[] = Array.isArray(body.folderNames)
      ? body.folderNames
          .filter((item: unknown): item is string => typeof item === 'string')
          .slice(0, MAX_FOLDERS_PER_REQUEST)
      : [];

    if (folderNames.length === 0) {
      return NextResponse.json({ error: '未提供文件夹名' }, { status: 400 });
    }

    const results: FolderStageRouteResult[] = folderNames.map(name => {
      const exact = matchStageByFolderName(name);
      return exact
        ? { name, stage: exact, source: 'exact' as const }
        : { name, stage: null, source: 'none' as const };
    });

    // 只把精确匹配不上的交给模型，能省一次调用就省一次。
    const pending = results
      .map((item, index) => ({ item, index }))
      .filter(entry => entry.item.source === 'none');

    let modelCall;
    let error: string | undefined;
    if (pending.length > 0) {
      const project = projectId ? await getProject(projectId) : null;
      const classified = await classifyFoldersWithModel({
        folderNames: pending.map(entry => entry.item.name),
        projectNotes: project?.description,
        customHeaders: HeaderUtils.extractForwardHeaders(request.headers),
      });
      modelCall = classified.modelCall;
      error = classified.error;
      pending.forEach((entry, position) => {
        const stage = classified.stages[position];
        if (stage) {
          results[entry.index] = {
            name: entry.item.name,
            stage,
            source: 'model',
          };
        }
      });
    }

    const undecided = results.filter(item => !item.stage).length;
    console.log(
      `[folders] ${folderNames.length} 个文件夹：精确命中 ${
        results.filter(item => item.source === 'exact').length
      }，模型判出 ${
        results.filter(item => item.source === 'model').length
      }，未能区分 ${undecided}`
    );
    for (const item of results) {
      console.log(`[folders]   ${item.name} → ${item.stage ?? '未能区分'}（${item.source}）`);
    }

    return NextResponse.json({ results, error, modelCall });
  } catch (error) {
    console.error('Folders route error:', error);
    return NextResponse.json(
      {
        error: '文件夹判阶段失败',
        details: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    );
  }
}
