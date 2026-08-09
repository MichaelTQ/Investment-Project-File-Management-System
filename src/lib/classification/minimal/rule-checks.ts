import { compareBusinessStages } from '../../folder-structure';
import { matchSpecTerm } from '../naming-spec';
import { leafName } from '../source-path';
import type { ConflictFinding } from './conflict-review';
import { hasExtractedFacts, type MinimalDocument } from './store';

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
 * 却归在**比记载变更的那份更晚**的阶段。
 *
 * 起点是君柔那对公司章程：股东会决议写着注册资本"由 11.73624 变更为 13.04027"，
 * 而某份章程记的是 11.73624——它形成于变更之前。发现这个不需要模型，只需要字符串相等。
 *
 * **但"形成于变更之前"推不出"应当归在更早的阶段"，这是之前这条规则的硬伤。**
 * 一次交易的文件天然分布在变更的两侧：合同先签、决议再批、新章程后出，它们全都
 * 属于同一个阶段。促成变更的那些文件必然记着变更前的值——那正是这笔交易的起点，
 * 不是错放的证据。实测佰特微就卡在这里：《投资合同书》记着 220.9526 万元，与记载
 * "220.9526 → 225.0443"的《股东会决议》同处投资实施，规则每次都报，而它本来就该在
 * 那儿。同阶段共存是"阶段跨越了这次变更"的正常形态，不是矛盾。
 *
 * 所以只报**能证明**的那一种：变更前的值出现在比变更更晚的阶段里。这种情况没法用
 * "同一笔交易"解释——交易结束之后不会再产生记录交易前状态的文件。
 *
 * 反方向（记着变更后的值却归在更早阶段）刻意不查：交易文件经常前瞻性地写明
 * "增资后注册资本为 X"，那是约定不是既成事实，查了就是一片误报。
 *
 * 同阶段那一类交给模型复核。它拿得到各方身份——人分辨这两种情况靠的就是
 * "这份文件里有没有本轮新进来的投资方"，而那是读文件读出来的，不是算术算出来的。
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

        // 数值指向变更之前，却归在比变更更晚的阶段。同阶段不算——见函数注释。
        if (
          matchesBefore &&
          compareBusinessStages(other.stage, anchor.stage) > 0
        ) {
          findings.push({
            sourcePaths: [leafName(other.sourcePath), leafName(anchor.sourcePath)],
            description: `《${leafName(other.sourcePath)}》记载的${change.field}等于变更前的值，说明它形成于这次变更之前，但它归在 ${other.stage}，比记载这次变更的《${leafName(anchor.sourcePath)}》所在的 ${anchor.stage} 更晚。`,
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
  // 判据统一走 hasExtractedFacts，不再各处自己看 sourceQuality：模型经常自报
  // filename_only 却给出了日期和摘录，两边口径不一致时，同一份文件会既算"已提取"
  // 又算"没读过"。
  const unread = documents.filter(document => !hasExtractedFacts(document));

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
            if (!hasExtractedFacts(document)) {
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

  // 兜底：没命中上面任何信号的未读文件也要列出来。
  // 它们此前哪儿都不显示，只在"已提取的事实"里占一条空壳记录——看上去像系统读过，
  // 实际一个字都没读。这里是它们唯一的去处。
  for (const document of unread) {
    if (suggestions.has(document.sourcePath)) continue;
    suggestions.set(
      document.sourcePath,
      '按文件名归档，尚未读取内容'
    );
  }

  return [...suggestions.entries()].map(([sourcePath, reason]) => ({
    sourcePath,
    reason,
  }));
}
