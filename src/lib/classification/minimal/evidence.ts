import type { ArchiveBusinessStage } from '../../folder-structure';
import {
  extractCapitalTransition,
  extractFormationDate,
  extractRegisteredCapital,
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
  amount: number;
  evidence: string;
}

export type EvidenceStrength = 'high' | 'medium' | 'low' | 'none';

export interface CapitalTendency {
  side: 'before' | 'after';
  siblingSourcePath: string;
  currentAmount: number;
  siblingAmount: number;
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

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.00001, Math.abs(right) * 0.0001);
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

  const capital = extractRegisteredCapital(current.facts);
  let transactionSide: TransactionSide | null = null;

  if (capital !== null) {
    for (const document of others) {
      if (document.sourcePath === current.sourcePath) continue;
      if (!TRANSACTION_RECORD_TYPES.has(document.facts.documentType)) continue;
      const transition = extractCapitalTransition(document.facts);
      if (!transition) continue;

      if (approximatelyEqual(capital, transition.before)) {
        transactionSide = {
          side: 'before',
          anchorSourcePath: document.sourcePath,
          anchorStage: document.stage,
          amount: capital,
          evidence: transition.evidence,
        };
        break;
      }
      if (approximatelyEqual(capital, transition.after)) {
        transactionSide = {
          side: 'after',
          anchorSourcePath: document.sourcePath,
          anchorStage: document.stage,
          amount: capital,
          evidence: transition.evidence,
        };
        break;
      }
    }
  }

  // 没有交易锚点时，同类文件之间的金额差异只能形成倾向，不能形成结论。
  let tendency: CapitalTendency | null = null;
  if (!transactionSide && capital !== null) {
    for (const document of others) {
      if (document.facts.documentType !== current.facts.documentType) continue;
      const siblingCapital = extractRegisteredCapital(document.facts);
      if (siblingCapital === null || approximatelyEqual(capital, siblingCapital)) {
        continue;
      }
      tendency = {
        side: capital < siblingCapital ? 'before' : 'after',
        siblingSourcePath: document.sourcePath,
        currentAmount: capital,
        siblingAmount: siblingCapital,
      };
      break;
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
    ? `注册资本 ${transactionSide.amount} 万元与“${transactionSide.anchorSourcePath}”记载的变更${transactionSide.side === 'before' ? '前' : '后'}值一致`
    : tendency
      ? `缺少交易文件佐证，仅按"投资项目多为增资、金额较低者形成较早"作倾向性推测（本文件 ${tendency.currentAmount} 万元，同类文件 ${tendency.siblingAmount} 万元）`
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
    const { side, anchorSourcePath, amount, evidence } = resolved.transactionSide;
    lines.push(
      `【已由代码确定】本文件记载的注册资本 ${amount} 万元，与“${anchorSourcePath}”记载的变更${side === 'before' ? '前' : '后'}值一致，` +
        `因此本文件形成于该笔交易${side === 'before' ? '之前' : '之后'}。原文依据：${evidence}`
    );
    lines.push(
      '这条结论已经过确定性计算，请直接采用，不要再自行比较金额大小推断先后。'
    );
  } else if (resolved.tendency) {
    const { side, siblingSourcePath, currentAmount, siblingAmount } =
      resolved.tendency;
    lines.push(
      `项目里没有记载资本变更前后值的交易文件，无法确定先后。` +
        `本文件注册资本 ${currentAmount} 万元，同类型文件“${siblingSourcePath}”为 ${siblingAmount} 万元。`
    );
    lines.push(
      `【倾向性推测，不是证据】投资项目中增资多于减资，金额较低者通常形成较早，` +
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
