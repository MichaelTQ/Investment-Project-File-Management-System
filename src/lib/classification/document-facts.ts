import { z } from 'zod';

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
  error?: string;
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

export function parseDocumentFactsResponse(value: string): DocumentFacts {
  const json = extractFirstJsonObject(value);
  if (!json) throw new Error('模型响应中没有合法 JSON 对象');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('模型响应中的 JSON 无法解析');
  }

  const result = DocumentFactsSchema.safeParse(parsed);
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
