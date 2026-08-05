import type { ArchiveBusinessStage } from '../../folder-structure';
import { leafName } from '../source-path';
import type { MinimalDocument } from './store';

/**
 * 时间线：把各文件抽出来的日期汇总排序。
 *
 * 这里只做机械操作，不含任何业务知识——不判断哪种日期更重要，不推断文件先后，
 * 不给文件类型排序。所有解释性的工作都交给模型，代码只负责把事实摆整齐。
 *
 * 这个文件曾经还包含"交易锚点""增资倾向""证据强度档位"等一整套推断逻辑，
 * 已全部删除：那些都是把投资业务知识焊死在代码里，换一类项目就失效，
 * 而且会让模型看到的其实是代码的结论，而不是原始事实。
 */

export interface TimelineEntry {
  date: string;
  sourcePath: string;
  stage: ArchiveBusinessStage | null;
  meaning: string;
  evidence: string;
}

/** 按日期排序汇总所有文件的日期事实。没有日期的文件不出现在时间线里。 */
export function buildTimeline(documents: MinimalDocument[]): TimelineEntry[] {
  return documents
    .flatMap(document =>
      document.facts.dates
        .filter((item): item is typeof item & { date: string } =>
          Boolean(item.date)
        )
        .map(item => ({
          date: item.date,
          sourcePath: document.sourcePath,
          stage: document.stage,
          meaning: item.meaning,
          evidence: item.evidence,
        }))
    )
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.sourcePath.localeCompare(right.sourcePath)
    );
}

/** 把时间线整理成文本，供模型阅读。只列事实，不做归纳。 */
export function describeTimeline(entries: TimelineEntry[]): string {
  if (entries.length === 0) return '项目里还没有带日期的文件。';
  return entries
    .map(
      entry =>
        `- ${entry.date} ${leafName(entry.sourcePath)}` +
        `${entry.stage ? `（已归入 ${entry.stage}）` : '（尚未归档）'}` +
        `：${entry.meaning}。原文：${entry.evidence}`
    )
    .join('\n');
}
