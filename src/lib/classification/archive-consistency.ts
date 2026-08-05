import type { ArchiveBusinessStage } from '../folder-structure';
import type { DocumentFacts, DocumentType } from './document-facts';

/**
 * 归档一致性校验器。
 *
 * 纯计算，不调用模型，不读取原始文件——只看每份文件已经抽好的事实和它当前的归档
 * 结论。因此可以在每次有新文件进来之后对全项目跑一遍，成本可以忽略。
 *
 * 它的职责是**推翻**分类，不是**产生**分类。代码能确定地算出"A 记载的资本等于交易
 * 文件的变更前值，所以 A 形成于该交易之前"；但算不出"这份财务报表属于尽调还是投资
 * 决策"。因此校验器沉默不代表它认可当前分类，只代表它无话可说——调用方不得把沉默
 * 当作赞成票。
 *
 * 关键设计：决定性证据经常比它要决定的那份文件晚到。先传的章程当时判不准是正常的，
 * 直到股东会决议进来，才能一次性把两份章程都钉死。所以校验必须每次全量重跑。
 */

/** 阶段先后顺序，与归档目录的排列一致。 */
const STAGE_ORDER: ArchiveBusinessStage[] = [
  'pre_initiation',
  'initiation',
  'due_diligence',
  'investment_decision',
  'investment_execution',
  'post_investment',
  'exit_decision',
  'exit_execution',
];

function stageRank(stage: ArchiveBusinessStage | null): number | null {
  if (!stage) return null;
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 ? index : null;
}

/**
 * 记载了交易的文件类型。只有这些文件里的"由 X 变为 Y"才被当作交易锚点——
 * 普通文件顺带提到的前后值不足以定义一次交易。
 */
const TRANSACTION_RECORD_TYPES: DocumentType[] = [
  'shareholder_resolution',
  'capital_increase_agreement',
  'board_resolution',
  'investment_committee_resolution',
];

/**
 * 档案完整性提示：出现了左边的文件，通常意味着右边的文件也应该在档。
 * 这是提示清单，不是判断依据——缺一条只是少一个提醒，不影响任何分类结论。
 */
const EXPECTED_COMPANIONS: Array<{
  present: DocumentType;
  expected: DocumentType;
  hint: string;
}> = [
  {
    present: 'closing_confirmation',
    expected: 'capital_increase_agreement',
    hint: '有交割确认函，通常应有对应的增资协议在档',
  },
  {
    present: 'payment_notice',
    expected: 'capital_increase_agreement',
    hint: '有缴款通知书，通常应有对应的增资协议在档',
  },
  {
    present: 'capital_increase_agreement',
    expected: 'shareholder_resolution',
    hint: '有增资协议，通常应有批准本次增资的股东会决议在档',
  },
];

export interface ArchiveDocument {
  sourcePath: string;
  facts: DocumentFacts;
  /** 这份文件当前存着的归档阶段，也就是 diff 的对象。 */
  currentStage: ArchiveBusinessStage | null;
  /** 内容指纹，用于识别重复文件。缺省时跳过重复检查。 */
  fingerprint?: string;
}

export type ConsistencyFindingKind =
  | 'transaction_side_conflict'
  | 'version_order_conflict'
  | 'duplicate_stage_mismatch'
  | 'missing_companion_document';

export interface ConsistencyFinding {
  kind: ConsistencyFindingKind;
  /** 项目级提示（档案缺口）时为空字符串。 */
  sourcePath: string;
  currentStage: ArchiveBusinessStage | null;
  /** 代码能确定的约束，用业务语言表述；不一定能定位到唯一阶段。 */
  constraint: string;
  reason: string;
  evidence: string[];
  relatedSourcePaths: string[];
}

function parseAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/[\d,.]+/);
  if (!match) return null;
  const amount = Number(match[0].replaceAll(',', ''));
  return Number.isFinite(amount) ? amount : null;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.00001, Math.abs(right) * 0.0001);
}

/** 这份文件自己记载的注册资本。只取明确写出的数值，不做任何推算。 */
export function extractRegisteredCapital(facts: DocumentFacts): number | null {
  const texts = [
    ...facts.transactionChanges
      .filter(change => change.field.includes('注册资本'))
      .flatMap(change => [change.after ?? '', change.before ?? '']),
    ...facts.evidenceQuotes.filter(quote => quote.includes('注册资本')),
  ].filter(Boolean);

  const amounts = texts.flatMap(value =>
    [
      ...value.matchAll(/注册资本[^\d]{0,30}([\d,.]+)/g),
      ...value.matchAll(/([\d,.]+)\s*万元/g),
    ]
      .map(match => Number(match[1].replaceAll(',', '')))
      .filter(Number.isFinite)
  );

  return amounts.length > 0 ? Math.max(...amounts) : null;
}

interface CapitalTransition {
  sourcePath: string;
  before: number;
  after: number;
  stage: ArchiveBusinessStage;
  evidence: string;
}

/**
 * 从一份交易文件里读出"注册资本由 X 变为 Y"。
 *
 * 不假设方向：减资决议同样写明前后值，一样能用。刻意不做"金额大的在后"这类推断——
 * 注册资本并非单调递增（减资、回购、对赌退出都会让它减少），凭大小推先后是循环论证。
 */
export function extractCapitalTransition(
  facts: DocumentFacts
): { before: number; after: number; evidence: string } | null {
  for (const change of facts.transactionChanges) {
    if (!change.field.includes('注册资本')) continue;
    const before = parseAmount(change.before);
    const after = parseAmount(change.after);
    if (before !== null && after !== null && before !== after) {
      return { before, after, evidence: change.evidence };
    }
  }

  const text = [
    ...facts.evidenceQuotes,
    ...facts.explicitStageClues,
    ...facts.transactionChanges.map(change => change.evidence),
  ].join('\n');
  const match = text.match(
    /注册资本[^\d]{0,10}由(?:人民币)?\s*([\d,.]+)\s*万元[^\d]{0,10}(?:增加至|增至|减少至|减至|变更为)(?:人民币)?\s*([\d,.]+)\s*万元/
  );
  if (!match) return null;
  const before = Number(match[1].replaceAll(',', ''));
  const after = Number(match[2].replaceAll(',', ''));
  return Number.isFinite(before) && Number.isFinite(after) && before !== after
    ? { before, after, evidence: match[0] }
    : null;
}

/** 表示"文件在此时形成"的日期含义。缴款期限、有效期等未来日期不在此列。 */
const FORMATION_DATE_TERMS = [
  '签署',
  '签订',
  '签字',
  '批准',
  '通过',
  '决议',
  '修订',
  '修改',
  '生效',
  '形成',
  '出具',
  '召开',
  '发出',
  '成立',
];

/**
 * 取文件的形成时点。
 *
 * 找不到就返回 null，**不退而求其次抓任意一个日期**。实测中公司章程只抽出了
 * "2030-03-30 股东认缴出资截止日期"——那是未来的缴款期限，与章程何时形成毫无
 * 关系。拿它当文件日期会让两份文件的先后比较得出完全错误的结论。
 */
export function extractFormationDate(facts: DocumentFacts): string | null {
  return (
    facts.dates.find(
      item =>
        item.date &&
        FORMATION_DATE_TERMS.some(term => item.meaning.includes(term))
    )?.date ?? null
  );
}

/** 数字链：当前文件的资本匹配某笔交易的变更前 / 变更后值，据此定出它在交易的哪一侧。 */
function checkTransactionSides(
  documents: ArchiveDocument[]
): ConsistencyFinding[] {
  const transitions: CapitalTransition[] = [];
  for (const document of documents) {
    if (!TRANSACTION_RECORD_TYPES.includes(document.facts.documentType)) {
      continue;
    }
    if (!document.currentStage) continue;
    const transition = extractCapitalTransition(document.facts);
    if (!transition) continue;
    transitions.push({
      sourcePath: document.sourcePath,
      before: transition.before,
      after: transition.after,
      stage: document.currentStage,
      evidence: transition.evidence,
    });
  }
  if (transitions.length === 0) return [];

  const findings: ConsistencyFinding[] = [];
  for (const document of documents) {
    const capital = extractRegisteredCapital(document.facts);
    if (capital === null) continue;
    const currentRank = stageRank(document.currentStage);
    if (currentRank === null) continue;

    for (const transition of transitions) {
      if (transition.sourcePath === document.sourcePath) continue;
      const anchorRank = stageRank(transition.stage);
      if (anchorRank === null) continue;

      const matchesBefore = approximatelyEqual(capital, transition.before);
      const matchesAfter = approximatelyEqual(capital, transition.after);
      // 变更前后值相同的交易已在提取时排除，这里两者不会同时成立。
      if (!matchesBefore && !matchesAfter) continue;

      if (matchesBefore && currentRank >= anchorRank) {
        findings.push({
          kind: 'transaction_side_conflict',
          sourcePath: document.sourcePath,
          currentStage: document.currentStage,
          constraint: '形成于该笔交易之前',
          reason: `本文件记载的注册资本 ${capital} 万元与“${transition.sourcePath}”记载的变更前值一致，说明它形成于该笔交易之前；但当前归档阶段不早于该交易所属阶段。`,
          evidence: [transition.evidence],
          relatedSourcePaths: [transition.sourcePath],
        });
      } else if (matchesAfter && currentRank < anchorRank) {
        findings.push({
          kind: 'transaction_side_conflict',
          sourcePath: document.sourcePath,
          currentStage: document.currentStage,
          constraint: '形成于该笔交易之后',
          reason: `本文件记载的注册资本 ${capital} 万元与“${transition.sourcePath}”记载的变更后值一致，说明它形成于该笔交易之后；但当前归档阶段早于该交易所属阶段。`,
          evidence: [transition.evidence],
          relatedSourcePaths: [transition.sourcePath],
        });
      }
    }
  }
  return findings;
}

/**
 * 版本先后：同类型文件之间，日期早的那份归档阶段不应该晚于日期晚的那份。
 *
 * 只在同类型之间比较。跨类型比日期不成立——增资协议 4 月 1 日签署、股东会决议
 * 4 月 10 日形成，两者都属投资实施，日期早并不意味着阶段早。
 */
function checkVersionOrder(
  documents: ArchiveDocument[]
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  for (const left of documents) {
    const leftDate = extractFormationDate(left.facts);
    const leftRank = stageRank(left.currentStage);
    if (!leftDate || leftRank === null) continue;

    for (const right of documents) {
      if (right.sourcePath === left.sourcePath) continue;
      if (right.facts.documentType !== left.facts.documentType) continue;
      const rightDate = extractFormationDate(right.facts);
      const rightRank = stageRank(right.currentStage);
      if (!rightDate || rightRank === null) continue;

      if (leftDate < rightDate && leftRank > rightRank) {
        findings.push({
          kind: 'version_order_conflict',
          sourcePath: left.sourcePath,
          currentStage: left.currentStage,
          constraint: `早于同类型文件“${right.sourcePath}”`,
          reason: `本文件日期 ${leftDate} 早于同类型文件“${right.sourcePath}”的 ${rightDate}，但归档阶段却更晚。`,
          evidence: [`${leftDate} 早于 ${rightDate}`],
          relatedSourcePaths: [right.sourcePath],
        });
      }
    }
  }
  return findings;
}

/** 重复文件：内容完全相同却归进了不同阶段，必有一份是错的。 */
function checkDuplicates(documents: ArchiveDocument[]): ConsistencyFinding[] {
  const groups = new Map<string, ArchiveDocument[]>();
  for (const document of documents) {
    if (!document.fingerprint) continue;
    const group = groups.get(document.fingerprint) ?? [];
    group.push(document);
    groups.set(document.fingerprint, group);
  }

  const findings: ConsistencyFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const stages = new Set(group.map(item => item.currentStage));
    if (stages.size < 2) continue;
    for (const document of group) {
      findings.push({
        kind: 'duplicate_stage_mismatch',
        sourcePath: document.sourcePath,
        currentStage: document.currentStage,
        constraint: '与内容完全相同的文件归档阶段应一致',
        reason: `本文件与 ${group.length - 1} 份内容完全相同的文件归在了不同阶段。`,
        evidence: [],
        relatedSourcePaths: group
          .filter(item => item.sourcePath !== document.sourcePath)
          .map(item => item.sourcePath),
      });
    }
  }
  return findings;
}

/** 档案缺口：不判断分类对错，只提示可能漏归的文件。 */
function checkMissingCompanions(
  documents: ArchiveDocument[]
): ConsistencyFinding[] {
  const presentTypes = new Set(
    documents.map(document => document.facts.documentType)
  );
  return EXPECTED_COMPANIONS.filter(
    rule => presentTypes.has(rule.present) && !presentTypes.has(rule.expected)
  ).map(rule => ({
    kind: 'missing_companion_document' as const,
    sourcePath: '',
    currentStage: null,
    constraint: '档案完整性提示',
    reason: rule.hint,
    evidence: [],
    relatedSourcePaths: documents
      .filter(document => document.facts.documentType === rule.present)
      .map(document => document.sourcePath),
  }));
}

/**
 * 对全项目跑一遍一致性校验。返回空数组表示代码无话可说，**不表示当前分类正确**。
 */
export function checkArchiveConsistency(
  documents: ArchiveDocument[]
): ConsistencyFinding[] {
  if (documents.length === 0) return [];
  return [
    ...checkTransactionSides(documents),
    ...checkVersionOrder(documents),
    ...checkDuplicates(documents),
    ...checkMissingCompanions(documents),
  ];
}
