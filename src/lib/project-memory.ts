import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { DocumentFacts } from '@/lib/classification/document-facts';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export const PROJECT_STAGES = [
  'pre_initiation',
  'initiation',
  'due_diligence',
  'investment_decision',
  'investment_execution',
  'post_investment',
  'exit_decision',
  'exit_execution',
  'unknown',
] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];
export type ProjectContextSource = 'manual' | 'derived' | 'mixed';

export interface ProjectContextRecord {
  projectId: string;
  currentStage: ProjectStage;
  stageConfidence: number;
  summary: string;
  targetCompany: string | null;
  investors: string[];
  keyDates: Array<{ date: string; meaning: string }>;
  source: ProjectContextSource;
  contextVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEventRecord {
  id: string;
  projectId: string;
  eventType: string;
  stage: ProjectStage;
  eventDate: string | null;
  title: string;
  status: string;
  evidenceFileIds: string[];
  evidence: string[];
  confidence: number;
  requiresHumanConfirmation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentFingerprint {
  value: string;
  kind: 'content_sha256' | 'storage_identity' | 'metadata_identity';
}

export interface PersistDocumentFactsParams {
  projectId: string;
  archivedFileId?: string;
  originalName: string;
  storageKey?: string;
  fileSize: number;
  mimeType: string;
  fileBuffer?: Buffer;
  facts: DocumentFacts;
  extractionStatus: 'success' | 'fallback';
  extractionError?: string;
  extractorVersion: string;
  modelVersion: string;
}

export interface PersistedDocumentFact {
  id: string;
  projectId: string;
  archivedFileId: string | null;
  sourceFingerprint: string;
  documentType: string;
  extractionStatus: 'success' | 'fallback';
  extractionConfidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClassificationDecisionParams {
  projectId: string;
  archivedFileId?: string;
  documentFactId?: string;
  selectedFolderId?: string;
  selectedFolderName?: string;
  selectedFolderPath?: string[];
  candidateFolders?: Array<Record<string, unknown>>;
  evidence?: string[];
  contradictions?: string[];
  decisionScore: number;
  decisionSource: 'context' | 'human' | 'none';
  reasoning: string;
  modelVersion?: string;
  policyVersion: string;
  requiresReview: boolean;
}

function getDb(client?: SupabaseClient): SupabaseClient {
  return client ?? getSupabaseClient();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function createDocumentFingerprint(params: {
  fileBuffer?: Buffer;
  storageKey?: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
}): DocumentFingerprint {
  if (params.fileBuffer) {
    return {
      value: createHash('sha256').update(params.fileBuffer).digest('hex'),
      kind: 'content_sha256',
    };
  }

  const kind = params.storageKey ? 'storage_identity' : 'metadata_identity';
  const identity = JSON.stringify([
    params.storageKey ?? '',
    params.originalName,
    params.fileSize,
    params.mimeType,
  ]);
  return {
    value: createHash('sha256').update(identity).digest('hex'),
    kind,
  };
}

export function buildDocumentFactRow(params: PersistDocumentFactsParams) {
  const fingerprint = createDocumentFingerprint(params);
  const now = new Date().toISOString();

  return {
    project_id: params.projectId,
    archived_file_id: params.archivedFileId ?? null,
    source_fingerprint: fingerprint.value,
    fingerprint_kind: fingerprint.kind,
    original_name: params.originalName,
    storage_key: params.storageKey ?? null,
    file_size: params.fileSize,
    mime_type: params.mimeType,
    document_type: params.facts.documentType,
    raw_document_type: params.facts.rawDocumentType,
    title: params.facts.title,
    document_number: params.facts.documentNumber,
    version: params.facts.version,
    document_dates: params.facts.dates,
    parties: params.facts.parties,
    sign_status: params.facts.signStatus,
    transaction_changes: params.facts.transactionChanges,
    explicit_stage_clues: params.facts.explicitStageClues,
    evidence_quotes: params.facts.evidenceQuotes,
    warnings: params.facts.warnings,
    source_quality: params.facts.sourceQuality,
    extraction_confidence: clampConfidence(
      params.facts.extractionConfidence
    ),
    extraction_status: params.extractionStatus,
    extraction_error: params.extractionError ?? null,
    extractor_version: params.extractorVersion,
    model_version: params.modelVersion,
    facts_payload: params.facts,
    updated_at: now,
  };
}

function mapProjectContext(data: Record<string, unknown>): ProjectContextRecord {
  return {
    projectId: data.project_id as string,
    currentStage: data.current_stage as ProjectStage,
    stageConfidence: data.stage_confidence as number,
    summary: (data.summary as string) ?? '',
    targetCompany: (data.target_company as string | null) ?? null,
    investors: (data.investors as string[]) ?? [],
    keyDates:
      (data.key_dates as Array<{ date: string; meaning: string }>) ?? [],
    source: data.source as ProjectContextSource,
    contextVersion: data.context_version as number,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}

export async function getProjectContextRecord(
  projectId: string,
  client?: SupabaseClient
): Promise<ProjectContextRecord | null> {
  const { data, error } = await getDb(client)
    .from('project_contexts')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle();

  if (error) throw new Error(`获取项目上下文失败: ${error.message}`);
  return data ? mapProjectContext(data) : null;
}

export async function upsertProjectContextRecord(
  params: {
    projectId: string;
    currentStage: ProjectStage;
    stageConfidence: number;
    summary?: string;
    targetCompany?: string | null;
    investors?: string[];
    keyDates?: Array<{ date: string; meaning: string }>;
    source: ProjectContextSource;
    contextVersion?: number;
  },
  client?: SupabaseClient
): Promise<ProjectContextRecord> {
  const now = new Date().toISOString();
  const { data, error } = await getDb(client)
    .from('project_contexts')
    .upsert(
      {
        project_id: params.projectId,
        current_stage: params.currentStage,
        stage_confidence: clampConfidence(params.stageConfidence),
        summary: params.summary ?? '',
        target_company: params.targetCompany ?? null,
        investors: params.investors ?? [],
        key_dates: params.keyDates ?? [],
        source: params.source,
        context_version: params.contextVersion ?? 1,
        updated_at: now,
      },
      { onConflict: 'project_id' }
    )
    .select()
    .single();

  if (error || !data) {
    throw new Error(`保存项目上下文失败: ${error?.message ?? '未知错误'}`);
  }
  return mapProjectContext(data);
}

function mapProjectEvent(data: Record<string, unknown>): ProjectEventRecord {
  return {
    id: data.id as string,
    projectId: data.project_id as string,
    eventType: data.event_type as string,
    stage: data.stage as ProjectStage,
    eventDate: (data.event_date as string | null) ?? null,
    title: data.title as string,
    status: data.status as string,
    evidenceFileIds: (data.evidence_file_ids as string[]) ?? [],
    evidence: (data.evidence as string[]) ?? [],
    confidence: data.confidence as number,
    requiresHumanConfirmation: Boolean(data.requires_human_confirmation),
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}

export async function listProjectEventRecords(
  projectId: string,
  client?: SupabaseClient
): Promise<ProjectEventRecord[]> {
  const { data, error } = await getDb(client)
    .from('project_events')
    .select('*')
    .eq('project_id', projectId)
    .order('event_date', { ascending: true });

  if (error) throw new Error(`获取项目事件失败: ${error.message}`);
  return (data ?? []).map(mapProjectEvent);
}

export async function createProjectEventRecord(
  params: {
    projectId: string;
    eventType: string;
    stage: ProjectStage;
    eventDate?: string | null;
    title: string;
    status?: string;
    evidenceFileIds?: string[];
    evidence?: string[];
    confidence: number;
    requiresHumanConfirmation?: boolean;
  },
  client?: SupabaseClient
): Promise<ProjectEventRecord> {
  const { data, error } = await getDb(client)
    .from('project_events')
    .insert({
      project_id: params.projectId,
      event_type: params.eventType,
      stage: params.stage,
      event_date: params.eventDate ?? null,
      title: params.title,
      status: params.status ?? 'confirmed',
      evidence_file_ids: params.evidenceFileIds ?? [],
      evidence: params.evidence ?? [],
      confidence: clampConfidence(params.confidence),
      requires_human_confirmation:
        params.requiresHumanConfirmation ?? false,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`创建项目事件失败: ${error?.message ?? '未知错误'}`);
  }
  return mapProjectEvent(data);
}

export async function upsertDocumentFactsRecord(
  params: PersistDocumentFactsParams,
  client?: SupabaseClient
): Promise<PersistedDocumentFact> {
  const row = buildDocumentFactRow(params);
  const { data, error } = await getDb(client)
    .from('document_facts')
    .upsert(row, { onConflict: 'project_id,source_fingerprint' })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`保存文档事实失败: ${error?.message ?? '未知错误'}`);
  }

  return {
    id: data.id,
    projectId: data.project_id,
    archivedFileId: data.archived_file_id ?? null,
    sourceFingerprint: data.source_fingerprint,
    documentType: data.document_type,
    extractionStatus: data.extraction_status,
    extractionConfidence: data.extraction_confidence,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function linkDocumentFactToArchivedFile(
  documentFactId: string,
  archivedFileId: string,
  client?: SupabaseClient
): Promise<void> {
  const { error } = await getDb(client)
    .from('document_facts')
    .update({
      archived_file_id: archivedFileId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', documentFactId);

  if (error) throw new Error(`关联归档文件失败: ${error.message}`);
}

export async function createClassificationDecisionRecord(
  params: CreateClassificationDecisionParams,
  client?: SupabaseClient
): Promise<string> {
  const { data, error } = await getDb(client)
    .from('classification_decisions')
    .insert({
      project_id: params.projectId,
      archived_file_id: params.archivedFileId ?? null,
      document_fact_id: params.documentFactId ?? null,
      // 托管数据库暂未迁移列名；业务层只使用 folder 字段。
      selected_category_id: params.selectedFolderId ?? null,
      selected_category_name: params.selectedFolderName ?? null,
      selected_folder_path: params.selectedFolderPath ?? null,
      candidate_categories: params.candidateFolders ?? [],
      evidence: params.evidence ?? [],
      contradictions: params.contradictions ?? [],
      decision_score: clampConfidence(params.decisionScore),
      decision_source: params.decisionSource,
      reasoning: params.reasoning,
      model_version: params.modelVersion ?? null,
      policy_version: params.policyVersion,
      requires_review: params.requiresReview,
      review_status: params.requiresReview ? 'pending' : 'not_required',
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`保存分类决策失败: ${error?.message ?? '未知错误'}`);
  }
  return data.id;
}
