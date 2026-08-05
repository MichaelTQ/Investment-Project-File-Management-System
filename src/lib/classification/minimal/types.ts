import { z } from 'zod';

import type { ArchiveFolder } from '../../folder-structure';
import { PROJECT_STAGES, type ProjectStage } from '../../project-memory';
import { DocumentFactsSchema } from '../document-facts';

/**
 * 极简链路用到的判断结果类型。
 *
 * 这几个类型原本定义在已下线的 context-decision.ts 里（见
 * docs/RETIRED_AGENT_ARCHITECTURE.md）。删除 Agent 链路时搬到这里，
 * 使极简链路不再依赖任何旧模块。
 */

const ConfidenceLabelSchema = z.enum(['low', 'medium', 'high']);

export const ProjectTimelineEventSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  eventType: z.string().trim().min(1).max(128),
  stage: z.enum(PROJECT_STAGES),
  title: z.string().trim().min(1).max(300),
  evidenceFiles: z.array(z.string().trim().min(1).max(1024)).min(1).max(100),
  evidence: z.string().trim().min(1).max(1000),
  confidence: ConfidenceLabelSchema,
  needsHumanConfirmation: z.boolean().optional(),
});

export const ProjectContextSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  projectName: z.string().trim().min(1).max(200),
  targetCompany: z.string().trim().min(1).max(300).nullable().optional(),
  contextStatus: z.string().trim().min(1).max(100),
  latestEvidencedStage: z.enum(PROJECT_STAGES),
  stageConfidence: ConfidenceLabelSchema,
  timeline: z.array(ProjectTimelineEventSchema).max(200),
  conflicts: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(1000),
        evidenceFiles: z
          .array(z.string().trim().min(1).max(1024))
          .min(1)
          .max(100),
        needsHumanConfirmation: z.boolean(),
      })
    )
    .max(100)
    .optional(),
  openQuestions: z.array(z.string().trim().min(1).max(1000)).max(100),
});

export const RelatedDocumentFactsSchema = z.object({
  sourcePath: z.string().trim().min(1).max(1024),
  facts: DocumentFactsSchema,
});

export type ProjectContextSnapshot = z.infer<
  typeof ProjectContextSnapshotSchema
>;
export type RelatedDocumentFacts = z.infer<typeof RelatedDocumentFactsSchema>;

export interface ContextCandidateScore {
  folder: ArchiveFolder;
  score: number;
  evidence: string[];
  contradictions: string[];
}

export interface ContextClassificationDecision {
  status: 'decided' | 'insufficient' | 'conflict';
  selectedFolder: ArchiveFolder | null;
  businessStage: ProjectStage | null;
  stageConfidence: number;
  routingMethod: 'context_policy' | 'stage_policy' | 'needs_stage_review';
  confidence: number;
  candidates: ContextCandidateScore[];
  evidence: string[];
  contradictions: string[];
  requiresHumanReview: boolean;
  reasoning: string;
  policyVersion: string;
}
