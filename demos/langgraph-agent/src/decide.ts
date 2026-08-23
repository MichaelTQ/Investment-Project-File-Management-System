import { normalizeValue } from './fixture.js';
import { STAGE_LABEL, type BusinessStage, type ProjectDoc } from './types.js';

/**
 * 判定器（生产里是 `decideStageWithModel`，这里是它的确定性替身）。
 *
 * **判断权只有这一个出口。** agent 不判阶段，它只负责把事实凑齐送到这里来。
 *
 * 这里刻意**不含任何"文档类型 → 阶段"的映射表**。上一版架构就是死在那张表上：
 * 覆盖 8/35 却卡在必经之路上，说不出话的 27 份直接判不出来。这里只做两件事，
 * 都是**依据**而不是**结论**：
 *
 * 1. 数值链：本文件记载的数值，等于某份文件记载的"变更前值"还是"变更后值"。
 * 2. 日期链：本文件的落款日在那次变更之前还是之后。
 *
 * 换任何项目、任何文件类型，这两条都成立——这就是"依据"和"结论"的区别。
 */

export interface StageDecision {
  stage: BusinessStage | null;
  reasoning: string;
  evidence: string[];
  requiresHumanReview: boolean;
}

function valuesIn(doc: ProjectDoc): string[] {
  return doc.facts.evidenceQuotes.map(normalizeValue);
}

function mentions(doc: ProjectDoc, value: string): boolean {
  const needle = normalizeValue(value);
  if (!needle) return false;
  return valuesIn(doc).some(quote => quote.includes(needle));
}

export function decideStage(target: ProjectDoc, others: ProjectDoc[]): StageDecision {
  if (!target.facts.evidenceQuotes.length) {
    return {
      stage: null,
      reasoning: '没有读到这份文件的任何内容，无法判断。',
      evidence: [],
      requiresHumanReview: true,
    };
  }

  const evidence: string[] = [];
  const votes = new Map<BusinessStage, number>();
  const vote = (stage: BusinessStage, weight: number) =>
    votes.set(stage, (votes.get(stage) ?? 0) + weight);

  for (const anchor of others) {
    if (!anchor.stage) continue;
    for (const change of anchor.facts.transactionChanges) {
      const { field, before, after } = change;
      if (!before || !after || normalizeValue(before) === normalizeValue(after)) continue;

      if (mentions(target, after)) {
        vote(anchor.stage, 2);
        evidence.push(
          `本文件记载的${field}为 ${after}，与《${leaf(anchor)}》记载的“${field} ${before} → ${after}”的**变更后值**一致，` +
            `说明它形成于这次变更完成之后；《${leaf(anchor)}》归在「${STAGE_LABEL[anchor.stage]}」。`
        );
      } else if (mentions(target, before)) {
        evidence.push(
          `本文件记载的${field}为 ${before}，与《${leaf(anchor)}》记载的**变更前值**一致，说明它形成于这次变更之前。`
        );
      }

      // 日期链：只在有数值链的时候作为佐证，单独不足以定阶段。
      const anchorDate = anchor.facts.dates[0]?.date;
      const targetDate = target.facts.dates[0]?.date;
      if (anchorDate && targetDate && mentions(target, after)) {
        const later = targetDate >= anchorDate;
        evidence.push(
          `本文件落款日 ${targetDate} ${later ? '晚于' : '早于'}《${leaf(anchor)}》的 ${anchorDate}，与数值链${later ? '一致' : '矛盾'}。`
        );
        if (later) vote(anchor.stage, 1);
      }
    }
  }

  // 主体链：本文件里出现了某份已人工确认文件里的"本轮投资方"，是交易已发生的佐证。
  const newInvestors = others
    .flatMap(doc => doc.facts.parties.filter(p => p.role.includes('本轮投资方')).map(p => ({ doc, name: p.name })))
    .filter(item => target.facts.parties.some(p => p.name === item.name));
  for (const item of newInvestors) {
    if (!item.doc.stage) continue;
    vote(item.doc.stage, 1);
    evidence.push(
      `本文件的股东里出现了 ${item.name}——《${leaf(item.doc)}》把它记为本轮投资方，说明本轮交易已反映在本文件中。`
    );
  }

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const runnerUp = ranked[1];

  if (!top || (runnerUp && top[1] === runnerUp[1])) {
    return {
      stage: null,
      reasoning:
        evidence.length > 0
          ? '找到了一些事实，但不足以指向唯一阶段，转人工。'
          : '没有找到能把本文件定位到某个阶段的事实，转人工。',
      evidence,
      requiresHumanReview: true,
    };
  }

  return {
    stage: top[0],
    reasoning: `依据数值链与日期链，本文件形成于本轮交易完成之后，与「${STAGE_LABEL[top[0]]}」阶段的文件同侧。`,
    evidence,
    // 归档永远要人工确认——系统只做初筛，不取代人工审核。
    requiresHumanReview: true,
  };
}

function leaf(doc: ProjectDoc): string {
  return (doc.sourcePath.split('/').pop() ?? doc.sourcePath).replace(/\.[^.]+$/, '');
}
