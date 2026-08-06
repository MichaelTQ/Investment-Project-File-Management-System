import { matchSpecTerm } from '../naming-spec';
import { leafName } from '../source-path';
import type { ConflictFinding } from './conflict-review';
import type { MinimalDocument } from './store';

/**
 * 确定性复核：不调模型、不会误报的那两条。
 *
 * 模型复核（conflict-review）能发现说不出规则的问题，但它慢、贵、会误报，而且每次
 * 措辞都不一样。下面这两条相反：纯比对，结论稳定，每条都能指着原文说清为什么。
 * 所以它们常开，模型复核改成按需。
 *
 * **注意这里和被删掉的那个老校验器的区别。** 老校验器内置了"有交割确认函通常应有
 * 增资协议"这类业务预设，换个项目就失效。这里两条都不是业务知识：一条是数值相等
 * 的算术比对，另一条是拿客户自己写的规范去对照。系统仍然不许凭文件类型猜阶段。
 */

/** 数值比对时抹掉无关差异：全角括号、千分位、单位后缀、空白。 */
function normalizeValue(value: string): string {
  return value
    .replace(/[,，\s]/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .trim();
}

/**
 * 检查一：某份文件记载的数值等于另一份文件记载的"变更前值"，
 * 但它却归在变更之后的阶段（反之亦然）。
 *
 * 这就是君柔那对公司章程：股东会决议写着注册资本"由 11.73624 变更为 13.04027"，
 * 而某份章程记的是 11.73624——它必然形成于变更之前，不该和变更之后的文件归在一起。
 * 发现这个不需要模型，只需要字符串相等。
 */
export function checkValueTimepointConflicts(
  documents: MinimalDocument[]
): ConflictFinding[] {
  const findings: ConflictFinding[] = [];

  for (const anchor of documents) {
    if (!anchor.stage) continue;
    for (const change of anchor.facts.transactionChanges) {
      const before = change.before ? normalizeValue(change.before) : '';
      const after = change.after ? normalizeValue(change.after) : '';
      if (!before || !after || before === after) continue;

      for (const other of documents) {
        if (other.sourcePath === anchor.sourcePath || !other.stage) continue;

        // 只比同名字段，避免把不相干的数字凑成对。
        const sameField = other.facts.transactionChanges.filter(
          item => item.field === change.field
        );
        const otherValues = [
          ...sameField.flatMap(item =>
            [item.before, item.after].filter(Boolean).map(value =>
              normalizeValue(String(value))
            )
          ),
          ...other.facts.evidenceQuotes
            .filter(quote => quote.includes(change.field))
            .map(normalizeValue),
        ];

        const matchesBefore = otherValues.some(
          value => value === before || value.includes(before)
        );
        const matchesAfter = otherValues.some(
          value => value === after || value.includes(after)
        );
        // 两个值都能对上说明这份文件自己就记着变更，它不是被定位的对象。
        if (matchesBefore === matchesAfter) continue;

        // 数值指向变更之前，却和记载变更的文件归在同一个（或更晚的）阶段。
        if (matchesBefore && other.stage === anchor.stage) {
          findings.push({
            sourcePaths: [leafName(other.sourcePath), leafName(anchor.sourcePath)],
            description: `《${leafName(other.sourcePath)}》记载的${change.field}等于变更前的值，说明它形成于这次变更之前，但它与记载变更的《${leafName(anchor.sourcePath)}》归在同一阶段 ${anchor.stage}。`,
            evidence: [
              `${change.field}：${change.before} → ${change.after}（出自 ${leafName(anchor.sourcePath)}）`,
              `${leafName(other.sourcePath)} 记载的同一字段为 ${change.before}`,
            ],
          });
        }
      }
    }
  }

  return findings;
}

/**
 * 检查二：命名规范说 A，内容事实判 B。
 *
 * 两条彼此独立的证据链打架，是最值得人工过目的信号——比模型自己在事实里找出来的
 * 任何一条都硬。注意方向：**只报出来，不主张谁对**。规范说的是"通常叫这个名字的
 * 文件放这儿"，事实说的是"这份文件自己写了什么"，谁更可信要看具体情况。
 *
 * 只在词条唯一命中时才比：词条本来就跨阶段（章程、表决票这些）的时候，事实落在
 * 哪个候选里都不算冲突。
 */
export function checkSpecVsFactConflicts(
  documents: MinimalDocument[],
  termBySourcePath: Map<string, string | null>
): ConflictFinding[] {
  const findings: ConflictFinding[] = [];

  for (const document of documents) {
    if (!document.stage) continue;
    // 纯按命名规范落位的文件没有独立的第二条证据链，无从对照。
    if (document.stageSource === 'naming_rule') continue;

    const matched = matchSpecTerm(termBySourcePath.get(document.sourcePath));
    if (matched.kind !== 'unique') continue;
    const expected = matched.stages[0];
    if (expected === document.stage) continue;

    findings.push({
      sourcePaths: [leafName(document.sourcePath)],
      description: `《${leafName(document.sourcePath)}》的名称按归档规范对应「${matched.term}」，规范把它列在 ${expected}，但按文件内容判断归入了 ${document.stage}。两条依据不一致，请人工确认。`,
      evidence: [
        `命名规范：${matched.term} → ${expected}`,
        `内容判断：${document.stage}`,
      ],
    });
  }

  return findings;
}

/**
 * 值得人工深挖的文件。
 *
 * 用户可以自己挑哪些文件要提取事实，但那要求他事先就知道哪里可能有问题——而最该
 * 挖的往往看起来最正常（君柔那对章程各自都说得通）。所以系统零成本地把可疑的标出来，
 * 点不点仍由用户决定。三条信号都是纯比对，不调模型。
 */
export interface DeepenSuggestion {
  sourcePath: string;
  reason: string;
}

export function suggestDocumentsToDeepen(
  documents: MinimalDocument[]
): DeepenSuggestion[] {
  const suggestions = new Map<string, string>();
  const unread = documents.filter(
    document => document.facts.sourceQuality === 'filename_only'
  );

  // 信号一：同一归档位置下出现多份未读内容的文件，且标题高度相似。
  const byStage = new Map<string, MinimalDocument[]>();
  for (const document of documents) {
    if (!document.stage) continue;
    const bucket = byStage.get(document.stage) ?? [];
    bucket.push(document);
    byStage.set(document.stage, bucket);
  }
  for (const bucket of byStage.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const a = bucket[left];
        const b = bucket[right];
        const nameA = leafName(a.sourcePath).replace(/\.[^.]+$/, '');
        const nameB = leafName(b.sourcePath).replace(/\.[^.]+$/, '');
        if (nameA === nameB || nameA.includes(nameB) || nameB.includes(nameA)) {
          for (const document of [a, b]) {
            if (document.facts.sourceQuality === 'filename_only') {
              suggestions.set(
                document.sourcePath,
                '同一位置下有名称高度相似的多份文件，需要读内容才能分清先后'
              );
            }
          }
        }
      }
    }
  }

  // 信号二：项目里已经有人记下了"由 X 变为 Y"，说明存在能定方向的锚点，
  // 而这些没读过内容的文件正好无法与之比对。
  const hasAnchor = documents.some(
    document => document.facts.transactionChanges.length > 0
  );
  if (hasAnchor) {
    for (const document of unread) {
      if (suggestions.has(document.sourcePath)) continue;
      suggestions.set(
        document.sourcePath,
        '项目里已有记载数值变更的文件，读了内容才能判断这份属于变更前还是变更后'
      );
    }
  }

  return [...suggestions.entries()].map(([sourcePath, reason]) => ({
    sourcePath,
    reason,
  }));
}
