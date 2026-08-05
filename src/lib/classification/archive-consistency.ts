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
 * 不能充当交易锚点的文件类型。**全项目唯一的一份清单**，上传时判方向和事后校验
 * 都用它，不允许各处再抄一份。
 *
 * 这里用排除法而不是白名单。原先只认四种决议/协议，导致交割确认函、缴款通知书、
 * 出资证明书、变更后的营业执照这些白纸黑字写了前后值的文件全被挡在门外，锚点大量
 * 漏掉，然后静默退回"金额低者形成较早"的先验——这正是要避免的猜测。
 *
 * 需要挡住的其实只有一类：**转述别人交易的文件**。尽调报告、商业计划书、财务报表、
 * 信用报告、立项与投决材料都会引用标的历史上的增资记录，那些交易可能与本项目无关，
 * 拿它们当锚点会把文件钉到错误的时点上。
 *
 * 另一道门槛在 extractFieldTransitions：必须真的写出了变更前后两个值。所以这里
 * 放宽的只是"文件身份"，不是"证据标准"。
 */
const NON_ANCHOR_DOCUMENT_TYPES: DocumentType[] = [
  'due_diligence_report',
  'business_plan',
  'project_initiation_report',
  'project_initiation_application',
  'investment_recommendation',
  'investment_compliance_review',
  'financial_statement',
  'credit_report',
  'confidentiality_agreement',
  'meeting_minutes',
  'voting_result',
  'other',
  'unknown',
];

/** 这份文件写明的"由 X 变为 Y"是否可以用来给别的文件定位交易前后侧。 */
export function canAnchorTransaction(documentType: DocumentType): boolean {
  return !NON_ANCHOR_DOCUMENT_TYPES.includes(documentType);
}

/**
 * 档案完整性提示：出现了左边的文件，通常意味着右边的文件也应该在档。
 * 这是提示清单，不是判断依据——缺一条只是少一个提醒，不影响任何分类结论。
 */
const EXPECTED_COMPANIONS: Array<{
  present: DocumentType;
  expected: DocumentType;
  presentLabel: string;
  expectedLabel: string;
}> = [
  {
    present: 'closing_confirmation',
    expected: 'capital_increase_agreement',
    presentLabel: '交割确认函',
    expectedLabel: '增资协议',
  },
  {
    present: 'payment_notice',
    expected: 'capital_increase_agreement',
    presentLabel: '缴款通知书',
    expectedLabel: '增资协议',
  },
  {
    present: 'capital_increase_agreement',
    expected: 'shareholder_resolution',
    presentLabel: '增资协议',
    expectedLabel: '股东会决议',
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

/**
 * 数值 + 单位。单位必须一起比，否则「1000 万元」和「1000 元」会被当成同一个值。
 */
export interface ComparableValue {
  amount: number;
  unit: string;
}

const UNIT_PATTERN = '(?:万元|亿元|万美元|美元|万股|亿股|万|元|股|人|%|％)';

function normalizeUnit(unit: string): string {
  return unit === '％' ? '%' : unit;
}

function parseValue(text: string | null | undefined): ComparableValue | null {
  if (!text) return null;
  const match = text.match(new RegExp(`([\\d,.]+)\\s*(${UNIT_PATTERN})?`));
  if (!match) return null;
  const amount = Number(match[1].replaceAll(',', ''));
  if (!Number.isFinite(amount)) return null;
  return { amount, unit: normalizeUnit(match[2] ?? '') };
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.00001, Math.abs(right) * 0.0001);
}

/** 数值相等且单位兼容（相同，或有一方没写单位）才算匹配。 */
export function valuesMatch(
  left: ComparableValue,
  right: ComparableValue
): boolean {
  if (!approximatelyEqual(left.amount, right.amount)) return false;
  if (!left.unit || !right.unit) return true;
  return left.unit === right.unit;
}

/**
 * 字段名归一化。抽取出的字段名写法不统一——「注册资本」「公司注册资本」
 * 「注册资本总额」指的是同一件事，比对时必须能对上。
 */
function normalizeFieldName(field: string): string {
  return field
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(公司|本次|人民币|标的|合计|总额|金额|数额|情况)/g, '')
    .trim();
}

export function fieldsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeFieldName(left);
  const normalizedRight = normalizeFieldName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

export interface FieldTransition {
  field: string;
  before: ComparableValue;
  after: ComparableValue;
  evidence: string;
}

/**
 * 从一份交易文件里读出所有「某字段由 X 变为 Y」。
 *
 * 不限于注册资本——实缴出资额、持股比例、股东人数、董事席位，任何写明了前后值的
 * 字段都能作为交易锚点。不假设方向：减资、回购同样写明前后值，一样能用。
 * 刻意不做"数值大的在后"这类推断，凭大小推先后是循环论证。
 */
export function extractFieldTransitions(
  facts: DocumentFacts
): FieldTransition[] {
  const transitions: FieldTransition[] = [];

  for (const change of facts.transactionChanges) {
    const before = parseValue(change.before);
    const after = parseValue(change.after);
    if (!before || !after) continue;
    if (approximatelyEqual(before.amount, after.amount)) continue;
    transitions.push({
      field: change.field,
      before,
      after,
      evidence: change.evidence,
    });
  }

  // 文字表述兜底：事实里没拆成前后字段，但原文写了"由…增加至…"。
  const text = [
    ...facts.evidenceQuotes,
    ...facts.explicitStageClues,
    ...facts.transactionChanges.map(change => change.evidence),
  ].join('\n');
  const textPattern = new RegExp(
    `([\\u4e00-\\u9fa5]{2,10})[^\\d]{0,10}由(?:人民币)?\\s*([\\d,.]+)\\s*(${UNIT_PATTERN})?[^\\d]{0,10}(?:增加至|增至|上升至|减少至|减至|下降至|变更为|调整为|变为)(?:人民币)?\\s*([\\d,.]+)\\s*(${UNIT_PATTERN})?`,
    'g'
  );
  for (const match of text.matchAll(textPattern)) {
    const field = match[1];
    const before = {
      amount: Number(match[2].replaceAll(',', '')),
      unit: normalizeUnit(match[3] ?? ''),
    };
    const after = {
      amount: Number(match[4].replaceAll(',', '')),
      unit: normalizeUnit(match[5] ?? ''),
    };
    if (!Number.isFinite(before.amount) || !Number.isFinite(after.amount)) {
      continue;
    }
    if (approximatelyEqual(before.amount, after.amount)) continue;
    if (transitions.some(existing => fieldsMatch(existing.field, field))) {
      continue;
    }
    transitions.push({ field, before, after, evidence: match[0] });
  }

  return transitions;
}

/**
 * 这份文件自己就某个字段记载的数值。只取明确写出的，不做任何推算。
 *
 * 只查询交易锚点实际变动过的字段，而不是把文件里所有数字都抽出来——后者噪音太大，
 * 很容易让无关数字碰巧撞上交易金额。
 */
export function extractStatedValue(
  facts: DocumentFacts,
  field: string
): ComparableValue | null {
  for (const change of facts.transactionChanges) {
    if (!fieldsMatch(change.field, field)) continue;
    const stated = parseValue(change.after) ?? parseValue(change.before);
    if (stated) return stated;
  }

  const normalizedField = normalizeFieldName(field);
  if (!normalizedField) return null;
  const escaped = normalizedField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escaped}[^\\d]{0,30}?([\\d,.]+)\\s*(${UNIT_PATTERN})?`
  );
  for (const quote of [
    ...facts.evidenceQuotes,
    ...facts.explicitStageClues,
    facts.title,
  ]) {
    const match = quote.match(pattern);
    if (!match) continue;
    const amount = Number(match[1].replaceAll(',', ''));
    if (!Number.isFinite(amount)) continue;
    return { amount, unit: normalizeUnit(match[2] ?? '') };
  }
  return null;
}

interface AnchorTransition extends FieldTransition {
  sourcePath: string;
  stage: ArchiveBusinessStage;
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
export function collectAnchorTransitions(
  documents: ArchiveDocument[]
): AnchorTransition[] {
  const anchors: AnchorTransition[] = [];
  for (const document of documents) {
    if (!canAnchorTransaction(document.facts.documentType)) continue;
    if (!document.currentStage) continue;
    for (const transition of extractFieldTransitions(document.facts)) {
      anchors.push({
        ...transition,
        sourcePath: document.sourcePath,
        stage: document.currentStage,
      });
    }
  }
  return anchors;
}

function checkTransactionSides(
  documents: ArchiveDocument[]
): ConsistencyFinding[] {
  const anchors = collectAnchorTransitions(documents);
  if (anchors.length === 0) return [];

  const findings: ConsistencyFinding[] = [];
  const seen = new Set<string>();

  for (const document of documents) {
    const currentRank = stageRank(document.currentStage);
    if (currentRank === null) continue;

    for (const anchor of anchors) {
      if (anchor.sourcePath === document.sourcePath) continue;
      const anchorRank = stageRank(anchor.stage);
      if (anchorRank === null) continue;

      const stated = extractStatedValue(document.facts, anchor.field);
      if (!stated) continue;

      const matchesBefore = valuesMatch(stated, anchor.before);
      const matchesAfter = valuesMatch(stated, anchor.after);
      // 变更前后值相同的交易已在提取时排除，这里两者不会同时成立。
      if (!matchesBefore && !matchesAfter) continue;

      const side = matchesBefore ? 'before' : 'after';
      if (side === 'before' ? currentRank < anchorRank : currentRank >= anchorRank) {
        continue;
      }
      // 同一份文件可能同时匹配多个字段，只报一次。
      const key = `${document.sourcePath}::${anchor.sourcePath}::${side}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const valueText = `${stated.amount}${stated.unit}`;
      findings.push({
        kind: 'transaction_side_conflict',
        sourcePath: document.sourcePath,
        currentStage: document.currentStage,
        constraint: side === 'before' ? '形成于该笔交易之前' : '形成于该笔交易之后',
        reason:
          side === 'before'
            ? `本文件记载的${anchor.field} ${valueText} 与“${anchor.sourcePath}”记载的变更前值一致，说明它形成于该笔交易之前；但当前归档阶段不早于该交易所属阶段。`
            : `本文件记载的${anchor.field} ${valueText} 与“${anchor.sourcePath}”记载的变更后值一致，说明它形成于该笔交易之后；但当前归档阶段早于该交易所属阶段。`,
        evidence: [anchor.evidence],
        relatedSourcePaths: [anchor.sourcePath],
      });
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
    // 先说看见了什么，再挑明这条来自固定清单。原先写的是"通常应有…在档"，
    // 读起来像从本项目文件里推出的结论，其实只是一条预先写好的组合规则。
    reason:
      `档案里有${rule.presentLabel}，没有${rule.expectedLabel}。` +
      '这是固定检查清单上的一组常见搭配，不是从本项目文件中推出的结论。',
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
