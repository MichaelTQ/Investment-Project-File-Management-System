import type { ArchiveBusinessStage } from '../../folder-structure';
import {
  canAnchorTransaction,
  extractFieldTransitions,
  extractFormationDate,
  extractStatedValue,
  valuesMatch,
} from '../archive-consistency';
import { leafName } from '../source-path';
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

/**
 * 锚点没找到时，说清是哪一种没找到。
 *
 * 原先这一步是静音的：匹配不上就直接退回"金额低者形成较早"的先验，界面上只显示
 * 一句"缺少交易文件佐证"。于是三种完全不同的情况被混成一句话——项目里根本没有
 * 交易文件、有交易文件但本文件没写那个字段、本文件写了却对不上号。第三种尤其
 * 要紧：它往往意味着中间还有一次没归档的变更，或者 OCR 把数字读错了，属于需要
 * 人工介入的信号，而不是可以用先验糊过去的情况。
 */
export type AnchorMissReason =
  | 'no_other_documents'
  | 'no_transaction_records'
  | 'anchor_type_rejected'
  | 'field_not_stated'
  | 'value_mismatch';

export interface AnchorDiagnostic {
  reason: AnchorMissReason;
  /** 一句业务语言，可直接展示给用户，也会注入模型提示。 */
  detail: string;
  /** 参与比对的交易文件。 */
  anchorSourcePaths: string[];
  /** 涉及的字段名。 */
  fields: string[];
}

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
  /** 锚点为什么没找到。找到时为 null。 */
  anchorDiagnostic: AnchorDiagnostic | null;
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
 * 把匹配失败的细节归成一条可读的结论。四种情况的处置完全不同，不能混为
 * "证据不足"：数值对不上要人去查，字段没写要补文件，项目里没交易文件则只能等。
 */
function buildAnchorDiagnostic(input: {
  otherDocumentNames: string[];
  anchorSourcePaths: string[];
  fieldsNotStated: string[];
  mismatches: string[];
  rejectedAnchors: string[];
}): AnchorDiagnostic {
  const anchorNames = input.anchorSourcePaths.map(leafName);

  if (input.mismatches.length > 0) {
    return {
      reason: 'value_mismatch',
      detail:
        `本文件写明的数值与交易记录的变更前后值都对不上（${input.mismatches.join('；')}）。` +
        '通常意味着这两份文件之间还有一次没有归档的变更，或者数字识别有误，建议人工核对。',
      anchorSourcePaths: anchorNames,
      fields: input.fieldsNotStated,
    };
  }

  if (input.anchorSourcePaths.length > 0) {
    return {
      reason: 'field_not_stated',
      detail:
        `项目里有交易记录（${anchorNames.join('、')}）写明了${input.fieldsNotStated.join('、')}的变更前后值，` +
        '但本文件没有写明这些字段的数值，因此无法定位它在交易的哪一侧。',
      anchorSourcePaths: anchorNames,
      fields: input.fieldsNotStated,
    };
  }

  if (input.rejectedAnchors.length > 0) {
    return {
      reason: 'anchor_type_rejected',
      detail:
        `项目里有文件写明了变更前后值（${input.rejectedAnchors.join('、')}），` +
        '但它的文件类型未能识别或属于转述性文件，因此没有被采信为交易锚点。' +
        '若它确实是记载本次交易的文件，请先修正其文件类型再重跑。',
      anchorSourcePaths: input.rejectedAnchors,
      fields: [],
    };
  }

  // 这里只陈述代码实际看到的东西：有哪几份文件、它们都没写前后值。
  // 不写"应该有一份股东会决议"——项目该有什么文件是业务判断，代码不掌握，
  // 硬写进来会让一句模板读起来像结论。
  return input.otherDocumentNames.length > 0
    ? {
        reason: 'no_transaction_records',
        detail:
          `项目里另有 ${input.otherDocumentNames.length} 份文件（${input.otherDocumentNames.join('、')}），` +
          '但没有一份写明了"某字段由 X 变为 Y"，因此没有可用来定位交易前后侧的锚点。',
        anchorSourcePaths: [],
        fields: [],
      }
    : {
        reason: 'no_other_documents',
        detail: '项目里目前只有这一份文件，没有可比对的对象。',
        anchorSourcePaths: [],
        fields: [],
      };
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
  // 匹配失败的细节：用来在找不到锚点时说清差在哪，而不是静默退回先验。
  const anchorSourcePaths: string[] = [];
  const fieldsNotStated: string[] = [];
  const mismatches: string[] = [];

  // 因文件类型被挡下、但确实写明了前后值的候选锚点。必须单独记账：类型识别失败
  // （unknown）时决议会被静默挡掉，界面上却显示"缺少交易文件"，与事实不符。
  const rejectedAnchors: string[] = [];

  for (const document of others) {
    if (document.sourcePath === current.sourcePath) continue;
    if (!canAnchorTransaction(document.facts.documentType)) {
      if (extractFieldTransitions(document.facts).length > 0) {
        rejectedAnchors.push(
          `${leafName(document.sourcePath)}（类型 ${document.facts.documentType}）`
        );
      }
      continue;
    }

    for (const transition of extractFieldTransitions(document.facts)) {
      if (!anchorSourcePaths.includes(document.sourcePath)) {
        anchorSourcePaths.push(document.sourcePath);
      }
      const stated = extractStatedValue(current.facts, transition.field);
      if (!stated) {
        if (!fieldsNotStated.includes(transition.field)) {
          fieldsNotStated.push(transition.field);
        }
        continue;
      }
      const matchesBefore = valuesMatch(stated, transition.before);
      const matchesAfter = valuesMatch(stated, transition.after);
      if (!matchesBefore && !matchesAfter) {
        // 写了这个字段却与前后值都对不上——通常意味着中间还有一次没归档的变更，
        // 或者数字读错了。这是需要人看的信号，不能当作"没证据"糊过去。
        mismatches.push(
          `${transition.field}：本文件为 ${stated.amount}${stated.unit}，` +
            `“${leafName(document.sourcePath)}”记载的是 ` +
            `${transition.before.amount}${transition.before.unit} → ` +
            `${transition.after.amount}${transition.after.unit}`
        );
        continue;
      }

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

  const anchorDiagnostic = transactionSide
    ? null
    : buildAnchorDiagnostic({
        otherDocumentNames: others.map(document => leafName(document.sourcePath)),
        anchorSourcePaths,
        fieldsNotStated,
        mismatches,
        rejectedAnchors,
      });

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
    ? `${transactionSide.field} ${transactionSide.valueText} 与“${leafName(transactionSide.anchorSourcePath)}”记载的变更${transactionSide.side === 'before' ? '前' : '后'}值一致`
    : // 数值对不上是比"没有证据"更强的信号，优先说这个，别让先验盖住它。
      anchorDiagnostic?.reason === 'value_mismatch'
      ? anchorDiagnostic.detail
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
    anchorDiagnostic,
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
      `【已由代码确定】本文件记载的${field} ${valueText}，与“${leafName(anchorSourcePath)}”记载的变更${side === 'before' ? '前' : '后'}值一致，` +
        `因此本文件形成于该笔交易${side === 'before' ? '之前' : '之后'}。原文依据：${evidence}`
    );
    lines.push(
      '这条结论已经过确定性计算，请直接采用，不要再自行比较数值大小推断先后。'
    );
  } else if (resolved.anchorDiagnostic?.reason === 'value_mismatch') {
    // 对不上号时优先报这个，且不给倾向性推测——先验的前提（只发生过一次变更）
    // 在这里已经被证伪了，再按"金额低者在先"猜很可能猜反。
    lines.push(`【代码已比对，结果异常】${resolved.anchorDiagnostic.detail}`);
    lines.push(
      '请不要凭数值大小推断先后，在理由中写明存在对不上的数值，并把 review 设为 true。'
    );
  } else if (resolved.tendency) {
    const { side, siblingSourcePath, field, currentText, siblingText } =
      resolved.tendency;
    lines.push(
      `项目里没有记载该字段变更前后值的交易文件，无法确定先后。` +
        `本文件${field} ${currentText}，同类型文件“${leafName(siblingSourcePath)}”为 ${siblingText}。`
    );
    lines.push(
      `【倾向性推测，不是证据】投资项目中增资多于减资，数值较低者通常形成较早，` +
        `据此本文件**倾向于**是交易${side === 'before' ? '前' : '后'}版本。` +
        '请据此给出默认建议，但必须在理由中写明这是缺少交易文件时的推测，并把 review 设为 true。' +
        '若本文件有明确的减资、回购或退出表述，则不适用此倾向，应据实判断。'
    );
  } else if (resolved.anchorDiagnostic?.reason === 'anchor_type_rejected') {
    lines.push(`【代码未采信】${resolved.anchorDiagnostic.detail}`);
    lines.push(
      '你可以参考该文件写明的数值，但要在理由中写明其文件类型未确认，并把 review 设为 true。'
    );
  } else if (resolved.anchorDiagnostic?.reason === 'field_not_stated') {
    // 有锚点、只是这份文件没写那个字段：说清缺的是哪个字段，比笼统说"证据不足"有用。
    lines.push(`【代码已比对】${resolved.anchorDiagnostic.detail}`);
    lines.push(
      '不要凭空猜方向。若无法从其他事实判断，请如实说明缺少哪个数值，并把 review 设为 true。'
    );
  } else if (resolved.sameTypeSiblings.length > 0) {
    lines.push(
      `项目里有 ${resolved.sameTypeSiblings.length} 份同类型文件（${resolved.sameTypeSiblings.map(leafName).join('、')}），` +
        '但没有一份写明了某字段的变更前后值，本文件也读不到可比对的数值。'
    );
    lines.push(
      '此时不要凭空猜方向。若无法确定，请如实说明是哪个数值读不到，' +
        '不要断言项目里应当存在某份尚未见到的文件。'
    );
  } else {
    lines.push('项目里没有可用于比对的同类型文件或交易记录。');
  }

  return lines.join('\n');
}
