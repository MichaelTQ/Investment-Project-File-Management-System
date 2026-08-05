import type { ArchiveBusinessStage } from '../../folder-structure';
import {
  extractFieldTransitions,
  extractFormationDate,
  extractStatedValue,
  valuesMatch,
} from '../archive-consistency';
import type { MinimalDocument } from './store';

/**
 * 时间线与证据解析：全部由代码完成，不调用模型。
 *
 * 方案第 3 节的分工——模型负责"看见"（从扫描件里读出 11.73624 这个数），
 * 代码负责"定先后"（这个数等于某笔交易的变更前值，所以文件形成于交易之前）。
 * 实测中模型两次里错一次，且错得自信，所以方向判断不交给它。
 */

export interface TimelineEntry {
  date: string;
  sourcePath: string;
  stage: ArchiveBusinessStage | null;
  meaning: string;
  evidence: string;
}

/** 时间线就是把各文件事实里的日期汇总排序，不需要模型综合。 */
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

export interface TransactionSide {
  side: 'before' | 'after';
  anchorSourcePath: string;
  anchorStage: ArchiveBusinessStage | null;
  /** 用来定位的是哪个字段——不限于注册资本。 */
  field: string;
  valueText: string;
  evidence: string;
}

export type EvidenceStrength = 'high' | 'medium' | 'low' | 'none';

export interface CapitalTendency {
  side: 'before' | 'after';
  siblingSourcePath: string;
  field: string;
  currentText: string;
  siblingText: string;
}

export interface ResolvedEvidence {
  /** 代码算出的"这份文件在交易的哪一侧"。null 表示项目里没有可用的交易锚点。 */
  transactionSide: TransactionSide | null;
  /**
   * 没有交易锚点时的**倾向性推测**，只用来排默认选项，绝不作为证据。
   * 投资项目里增资远多于减资，所以金额较低者通常形成较早——但这是先验，不是证明。
   */
  tendency: CapitalTendency | null;
  /** 同项目里与本文件同类型的文件，存在时说明可能有版本歧义。 */
  sameTypeSiblings: string[];
  strength: EvidenceStrength;
  /** 由证据强度推导的把握程度，不由模型自报。 */
  confidence: number;
  basis: string;
}

const CONFIDENCE_BY_STRENGTH: Record<EvidenceStrength, number> = {
  high: 85,
  medium: 65,
  low: 45,
  none: 25,
};

/** 只有这些文件里的"由 X 变为 Y"才算交易锚点。 */
const TRANSACTION_RECORD_TYPES = new Set([
  'shareholder_resolution',
  'capital_increase_agreement',
  'board_resolution',
  'investment_committee_resolution',
]);

/**
 * 只认"文件形成时点"类日期。缴款期限、认缴出资截止日这类未来日期说明不了文件属于
 * 哪个阶段，拿它撑起中等把握等于给无关数据发合格证。
 */
function hasFormationDate(document: MinimalDocument): boolean {
  return extractFormationDate(document.facts) !== null;
}

/**
 * 这份文件写明了数值的字段。倾向性比较只在双方都写明的字段上进行，
 * 避免拿两份文件里不相干的数字硬比。
 */
function comparableFields(document: MinimalDocument): string[] {
  const fields = document.facts.transactionChanges.map(change => change.field);
  // 交易变化里没有时，退回投资档案里最常见的几个可比字段。
  return fields.length > 0
    ? fields
    : ['注册资本', '实缴出资额', '认缴出资额', '持股比例'];
}

/**
 * 给当前文件解析出可用的确定性证据。
 *
 * 刻意不做的事：不比大小。注册资本并非单调递增（减资、回购、对赌退出都会让它
 * 减少），凭金额大小推先后是循环论证。方向只来自交易文件白纸黑字的前后值。
 */
export function resolveEvidence(
  current: MinimalDocument,
  others: MinimalDocument[]
): ResolvedEvidence {
  const sameTypeSiblings = others
    .filter(
      document =>
        document.sourcePath !== current.sourcePath &&
        document.facts.documentType === current.facts.documentType
    )
    .map(document => document.sourcePath);

  // 遍历项目里所有交易文件写明的字段变更，不限于注册资本——实缴出资额、
  // 持股比例、股东人数，任何有前后值的字段都能定位当前文件在交易的哪一侧。
  let transactionSide: TransactionSide | null = null;
  for (const document of others) {
    if (document.sourcePath === current.sourcePath) continue;
    if (!TRANSACTION_RECORD_TYPES.has(document.facts.documentType)) continue;

    for (const transition of extractFieldTransitions(document.facts)) {
      const stated = extractStatedValue(current.facts, transition.field);
      if (!stated) continue;
      const matchesBefore = valuesMatch(stated, transition.before);
      const matchesAfter = valuesMatch(stated, transition.after);
      if (!matchesBefore && !matchesAfter) continue;

      transactionSide = {
        side: matchesBefore ? 'before' : 'after',
        anchorSourcePath: document.sourcePath,
        anchorStage: document.stage,
        field: transition.field,
        valueText: `${stated.amount}${stated.unit}`,
        evidence: transition.evidence,
      };
      break;
    }
    if (transactionSide) break;
  }

  // 没有交易锚点时，同类文件之间的数值差异只能形成倾向，不能形成结论。
  let tendency: CapitalTendency | null = null;
  if (!transactionSide) {
    outer: for (const document of others) {
      if (document.facts.documentType !== current.facts.documentType) continue;
      // 双方都写明了同一个字段，才谈得上比较。
      for (const field of comparableFields(current)) {
        const currentValue = extractStatedValue(current.facts, field);
        const siblingValue = extractStatedValue(document.facts, field);
        if (!currentValue || !siblingValue) continue;
        if (valuesMatch(currentValue, siblingValue)) continue;
        tendency = {
          side: currentValue.amount < siblingValue.amount ? 'before' : 'after',
          siblingSourcePath: document.sourcePath,
          field,
          currentText: `${currentValue.amount}${currentValue.unit}`,
          siblingText: `${siblingValue.amount}${siblingValue.unit}`,
        };
        break outer;
      }
    }
  }

  const strength: EvidenceStrength = transactionSide
    ? 'high'
    : hasFormationDate(current)
      ? 'medium'
      : tendency ||
          (current.facts.documentType !== 'unknown' &&
            current.facts.documentType !== 'other')
        ? 'low'
        : 'none';

  const basis = transactionSide
    ? `${transactionSide.field} ${transactionSide.valueText} 与“${transactionSide.anchorSourcePath}”记载的变更${transactionSide.side === 'before' ? '前' : '后'}值一致`
    : tendency
      ? `缺少交易文件佐证，仅按"投资项目多为增资、数值较低者形成较早"作倾向性推测（本文件${tendency.field} ${tendency.currentText}，同类文件 ${tendency.siblingText}）`
      : strength === 'medium'
        ? '只有文件形成日期可用，缺少可比对的交易记录'
        : strength === 'low'
          ? '只有文档类型可用，缺少数字和日期证据'
          : '没有可用的确定性证据';

  return {
    transactionSide,
    tendency,
    sameTypeSiblings,
    strength,
    confidence: CONFIDENCE_BY_STRENGTH[strength],
    basis,
  };
}

/** 把代码算好的结论整理成一段话，作为已解析事实注入模型提示。 */
export function describeResolvedEvidence(resolved: ResolvedEvidence): string {
  const lines: string[] = [];

  if (resolved.transactionSide) {
    const { side, anchorSourcePath, field, valueText, evidence } =
      resolved.transactionSide;
    lines.push(
      `【已由代码确定】本文件记载的${field} ${valueText}，与“${anchorSourcePath}”记载的变更${side === 'before' ? '前' : '后'}值一致，` +
        `因此本文件形成于该笔交易${side === 'before' ? '之前' : '之后'}。原文依据：${evidence}`
    );
    lines.push(
      '这条结论已经过确定性计算，请直接采用，不要再自行比较数值大小推断先后。'
    );
  } else if (resolved.tendency) {
    const { side, siblingSourcePath, field, currentText, siblingText } =
      resolved.tendency;
    lines.push(
      `项目里没有记载该字段变更前后值的交易文件，无法确定先后。` +
        `本文件${field} ${currentText}，同类型文件“${siblingSourcePath}”为 ${siblingText}。`
    );
    lines.push(
      `【倾向性推测，不是证据】投资项目中增资多于减资，数值较低者通常形成较早，` +
        `据此本文件**倾向于**是交易${side === 'before' ? '前' : '后'}版本。` +
        '请据此给出默认建议，但必须在理由中写明这是缺少交易文件时的推测，并把 review 设为 true。' +
        '若本文件有明确的减资、回购或退出表述，则不适用此倾向，应据实判断。'
    );
  } else if (resolved.sameTypeSiblings.length > 0) {
    lines.push(
      `项目里有 ${resolved.sameTypeSiblings.length} 份同类型文件（${resolved.sameTypeSiblings.join('、')}），` +
        '但没有找到记载资本变更前后值的交易文件，也读不到可比对的金额。'
    );
    lines.push(
      '此时不要凭空猜方向。若无法确定，请如实说明缺少一份记载资本变更的股东会决议或增资协议。'
    );
  } else {
    lines.push('项目里没有可用于比对的同类型文件或交易记录。');
  }

  return lines.join('\n');
}
