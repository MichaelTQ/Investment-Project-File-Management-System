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

/**
 * 把时间线整理成文本，供模型阅读。只列事实，不做归纳。
 *
 * showStage 控制要不要写出每份文件归在哪个阶段。这个值来自文件此刻实际所在的
 * 目录，而归档一律需要人工点确认（classify 恒定要求确认，不存在自动归档），
 * 因此它是人工确认过的结果，不是模型的猜测——措辞上必须说清这一点，否则模型
 * 会把它当成系统自己的输出，或者反过来当成不容置疑的铁证。
 *
 * 需要留意的缝隙：确认时下拉框的默认值就是模型建议，一路点确认的话，这个"人工
 * 确认"实质仍是模型的猜测。所以提示词里同时要求模型不得只凭这一条下结论。
 */
export function describeTimeline(
  entries: TimelineEntry[],
  options: { showStage?: boolean } = {}
): string {
  if (entries.length === 0) return '项目里还没有带日期的文件。';
  return entries
    .map(entry => {
      const stage = options.showStage
        ? entry.stage
          ? `（人工确认归入 ${entry.stage}）`
          : '（尚未归档）'
        : '';
      return `- ${entry.date} ${leafName(entry.sourcePath)}${stage}：${entry.meaning}。原文：${entry.evidence}`;
    })
    .join('\n');
}
