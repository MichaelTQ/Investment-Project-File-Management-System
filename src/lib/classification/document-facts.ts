import { z } from 'zod';

import type { ModelCallDiagnostics } from './chat-completions';

export const DocumentTypeSchema = z.enum([
  'company_charter',
  'capital_increase_agreement',
  'shareholder_agreement',
  'shareholder_resolution',
  'board_resolution',
  'investment_committee_resolution',
  'payment_notice',
  'closing_confirmation',
  'bank_receipt',
  'due_diligence_report',
  'business_plan',
  'project_initiation_report',
  'project_initiation_application',
  'meeting_minutes',
  'voting_result',
  'investment_recommendation',
  'investment_compliance_review',
  'business_license',
  'financial_statement',
  'credit_report',
  'confidentiality_agreement',
  'capital_contribution_certificate',
  'shareholder_register',
  'other',
  'unknown',
]);

export const DocumentDateSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  meaning: z.string().trim().min(1).max(100),
  evidence: z.string().trim().min(1).max(300),
});

export const DocumentPartySchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(100),
});

export const TransactionChangeSchema = z.object({
  field: z.string().trim().min(1).max(100),
  before: z.string().trim().max(200).nullable(),
  after: z.string().trim().max(200).nullable(),
  evidence: z.string().trim().min(1).max(300),
});

export const DocumentFactsSchema = z.object({
  schemaVersion: z.literal(1),
  documentType: DocumentTypeSchema,
  rawDocumentType: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  documentNumber: z.string().trim().max(100).nullable(),
  version: z.string().trim().max(100).nullable(),
  dates: z.array(DocumentDateSchema).max(20),
  parties: z.array(DocumentPartySchema).max(50),
  signStatus: z.enum([
    'unsigned',
    'signed',
    'sealed',
    'signed_and_sealed',
    'unknown',
  ]),
  transactionChanges: z.array(TransactionChangeSchema).max(30),
  explicitStageClues: z.array(z.string().trim().min(1).max(300)).max(30),
  evidenceQuotes: z.array(z.string().trim().min(1).max(500)).max(30),
  warnings: z.array(z.string().trim().min(1).max(300)).max(20),
  sourceQuality: z.enum([
    'text',
    'visual_summary',
    'image',
    'filename_only',
    'mixed',
  ]),
  extractionConfidence: z.number().int().min(0).max(100),
});

export type DocumentType = z.infer<typeof DocumentTypeSchema>;
export type DocumentFacts = z.infer<typeof DocumentFactsSchema>;

export interface DocumentFactsExtractionResult {
  status: 'success' | 'fallback';
  facts: DocumentFacts;
  modelCall?: ModelCallDiagnostics;
  error?: string;
  cacheHit?: boolean;
}

export function extractFirstJsonObject(value: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedString(
  value: unknown,
  maxLength: number,
  fallback = ''
): string {
  return typeof value === 'string'
    ? value.trim().slice(0, maxLength)
    : fallback;
}

// 模型在紧凑元组协议里经常把空值写成字符串字面量而不是 JSON null。这些值一旦
// 当作真实文本存下来，下游会把它读成一个具体的事实：交易变化里的 "null" → "11.7万"
// 会被理解成"发生了一次增资"，凭空造出一笔不存在的交易。空值必须还原为空值。
const NULLISH_LITERALS = new Set([
  'null',
  'none',
  'nil',
  'undefined',
  'nan',
  'n/a',
  'na',
  '无',
  '未知',
  '不适用',
  '不详',
  '-',
  '--',
  '—',
  '/',
]);

export function isNullishLiteral(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return NULLISH_LITERALS.has(value.trim().toLowerCase());
}

function nullableString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (isNullishLiteral(value)) return null;
  const normalized = normalizedString(value, maxLength);
  return normalized || null;
}

function normalizeDateValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(/[年/.]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/-+/g, '-');
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function stringArray(
  value: unknown,
  maxItems: number,
  maxLength: number
): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  return values
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeDocumentFactsPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (
    typeof value.documentType !== 'string' &&
    typeof value.rawDocumentType !== 'string' &&
    typeof value.title !== 'string'
  ) {
    return value;
  }
  const repairs = new Set<string>();

  const dates = (Array.isArray(value.dates) ? value.dates : [])
    .slice(0, 4)
    .flatMap(item => {
      if (!isRecord(item)) {
        repairs.add('已忽略无法解析的日期项');
        return [];
      }
      const meaning = normalizedString(item.meaning, 100);
      const evidence = normalizedString(item.evidence, 160);
      if (!meaning || !evidence) {
        repairs.add('已忽略缺少含义或证据的日期项');
        return [];
      }
      const date = normalizeDateValue(item.date);
      if (item.date && !date) repairs.add('无法标准化的日期已保留为 null');
      if (typeof item.date === 'string' && date !== item.date.trim()) {
        repairs.add('日期已标准化为 YYYY-MM-DD');
      }
      return [{ date, meaning, evidence }];
    });
  if (!Array.isArray(value.dates)) repairs.add('缺失的 dates 已补为空数组');

  const parties = (Array.isArray(value.parties) ? value.parties : [])
    .slice(0, 8)
    .flatMap(item => {
      if (!isRecord(item)) return [];
      const name = normalizedString(item.name, 200);
      const role = normalizedString(item.role, 100);
      if (!name || !role) {
        repairs.add('已忽略缺少名称或角色的主体项');
        return [];
      }
      return [{ name, role }];
    });
  if (!Array.isArray(value.parties)) repairs.add('缺失的 parties 已补为空数组');

  const transactionChanges = (
    Array.isArray(value.transactionChanges) ? value.transactionChanges : []
  )
    .slice(0, 6)
    .flatMap(item => {
      if (!isRecord(item)) return [];
      const field = normalizedString(item.field, 100);
      const evidence = normalizedString(item.evidence, 160);
      if (!field || !evidence) {
        repairs.add('已忽略缺少字段或证据的交易变化项');
        return [];
      }
      if (
        (typeof item.before === 'string' && item.before.trim().length > 100) ||
        (typeof item.after === 'string' && item.after.trim().length > 100)
      ) {
        repairs.add('过长的交易变化值已截断至 100 字符');
      }
      if (isNullishLiteral(item.before) || isNullishLiteral(item.after)) {
        repairs.add(
          '交易变化中写成文字的空值已还原为空，避免被误读为真实的变更前后值'
        );
      }
      return [
        {
          field,
            before: nullableString(item.before, 100),
            after: nullableString(item.after, 100),
          evidence,
        },
      ];
    });
  if (!Array.isArray(value.transactionChanges)) {
    repairs.add('缺失的 transactionChanges 已补为空数组');
  }

  const documentType = DocumentTypeSchema.safeParse(value.documentType);
  if (!documentType.success) repairs.add('无效的 documentType 已改为 unknown');
  const signStatus = z
    .enum(['unsigned', 'signed', 'sealed', 'signed_and_sealed', 'unknown'])
    .safeParse(value.signStatus);
  if (!signStatus.success) repairs.add('无效的 signStatus 已改为 unknown');
  const sourceQuality = z
    .enum(['text', 'visual_summary', 'image', 'filename_only', 'mixed'])
    .safeParse(value.sourceQuality);
  if (!sourceQuality.success) repairs.add('无效的 sourceQuality 已改为 mixed');
  const confidence =
    typeof value.extractionConfidence === 'number' &&
    Number.isFinite(value.extractionConfidence)
      ? Math.max(0, Math.min(100, Math.round(value.extractionConfidence)))
      : 0;
  if (confidence !== value.extractionConfidence) {
    repairs.add('事实完整度已校正到 0-100 的整数范围');
  }

  const explicitStageClues = stringArray(value.explicitStageClues, 4, 120);
  if (!Array.isArray(value.explicitStageClues)) {
    repairs.add('缺失的 explicitStageClues 已补为空数组');
  }
  const evidenceQuotes = stringArray(value.evidenceQuotes, 4, 120);
  if (!Array.isArray(value.evidenceQuotes)) {
    repairs.add('缺失的 evidenceQuotes 已补为空数组');
  }
  const existingWarnings = stringArray(value.warnings, 3, 120);
  const repairWarnings = [...repairs].map(message => `结构化输出已校正：${message}`);

  return {
    schemaVersion: 1,
    documentType: documentType.success ? documentType.data : 'unknown',
    rawDocumentType:
      normalizedString(value.rawDocumentType, 100) || '未知',
    title: normalizedString(value.title, 300) || '未知标题',
    documentNumber: nullableString(value.documentNumber, 100),
    version: nullableString(value.version, 100),
    dates,
    parties,
    signStatus: signStatus.success ? signStatus.data : 'unknown',
    transactionChanges,
    explicitStageClues,
    evidenceQuotes,
    warnings: [...repairWarnings, ...existingWarnings].slice(0, 8),
    sourceQuality: sourceQuality.success ? sourceQuality.data : 'mixed',
    extractionConfidence: confidence,
  };
}

export function parseDocumentFactsResponse(value: string): DocumentFacts {
  const json = extractFirstJsonObject(value);
  if (!json) throw new Error('模型响应中没有合法 JSON 对象');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('模型响应中的 JSON 无法解析');
  }

  const result = DocumentFactsSchema.safeParse(
    normalizeDocumentFactsPayload(parsed)
  );
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
    throw new Error(`文档事实不符合 Schema：${path} ${issue.message}`);
  }

  return result.data;
}

function titleFromFileName(fileName: string): string {
  const leafName = fileName.split(/[/\\]/).pop()?.trim() || '未知文件';
  const extensionIndex = leafName.lastIndexOf('.');
  return extensionIndex > 0 ? leafName.slice(0, extensionIndex) : leafName;
}

export function createFallbackDocumentFacts(
  fileName: string,
  warning: string
): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType: 'unknown',
    rawDocumentType: '未知',
    title: titleFromFileName(fileName),
    documentNumber: null,
    version: null,
    dates: [],
    parties: [],
    signStatus: 'unknown',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: [],
    warnings: [warning],
    sourceQuality: 'filename_only',
    extractionConfidence: 0,
  };
}
