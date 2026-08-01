import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// 系统表（必须保留）
export const healthCheck = pgTable("health_check", {
  id: integer().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
});

// 项目表
export const projects = pgTable(
  "projects",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").default(""),
    file_count: integer("file_count").default(0).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("projects_name_idx").on(table.name),
    index("projects_created_at_idx").on(table.created_at),
  ]
);

// 归档文件索引表（实际文件存对象存储）
export const archivedFiles = pgTable(
  "archived_files",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    project_id: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    project_name: varchar("project_name", { length: 255 }).notNull(),
    original_name: varchar("original_name", { length: 512 }).notNull(),
    archived_name: varchar("archived_name", { length: 512 }).notNull(),
    storage_key: varchar("storage_key", { length: 1024 }).notNull(),
    category_id: varchar("category_id", { length: 128 }).notNull(),
    category_name: varchar("category_name", { length: 255 }).notNull(),
    folder_path: jsonb("folder_path").notNull(),
    file_size: integer("file_size").notNull(),
    mime_type: varchar("mime_type", { length: 255 }).notNull(),
    confidence: integer("confidence").default(0),
    reasoning: text("reasoning").default(""),
    archived_at: timestamp("archived_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("archived_files_project_id_idx").on(table.project_id),
    index("archived_files_category_id_idx").on(table.category_id),
    index("archived_files_archived_at_idx").on(table.archived_at),
  ]
);

// 项目上下文：保存长期业务事实，不用于记录单次 Agent 执行进度。
export const projectContexts = pgTable(
  "project_contexts",
  {
    project_id: varchar("project_id", { length: 36 })
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    current_stage: varchar("current_stage", { length: 64 })
      .default("unknown")
      .notNull(),
    stage_confidence: integer("stage_confidence").default(0).notNull(),
    summary: text("summary").default("").notNull(),
    target_company: varchar("target_company", { length: 255 }),
    investors: jsonb("investors").default(sql`'[]'::jsonb`).notNull(),
    key_dates: jsonb("key_dates").default(sql`'[]'::jsonb`).notNull(),
    source: varchar("source", { length: 32 }).default("derived").notNull(),
    context_version: integer("context_version").default(1).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("project_contexts_stage_idx").on(table.current_stage)]
);

// 项目事件：以明确证据记录立项、投决、签约、交割和付款等业务事件。
export const projectEvents = pgTable(
  "project_events",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    project_id: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    event_type: varchar("event_type", { length: 128 }).notNull(),
    stage: varchar("stage", { length: 64 }).notNull(),
    event_date: date("event_date", { mode: "string" }),
    title: varchar("title", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).default("confirmed").notNull(),
    evidence_file_ids: jsonb("evidence_file_ids").default(sql`'[]'::jsonb`).notNull(),
    evidence: jsonb("evidence").default(sql`'[]'::jsonb`).notNull(),
    confidence: integer("confidence").default(0).notNull(),
    requires_human_confirmation: boolean("requires_human_confirmation")
      .default(false)
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("project_events_project_date_idx").on(table.project_id, table.event_date),
    index("project_events_type_idx").on(table.event_type),
  ]
);

// 文档事实：允许在正式归档前创建，再通过 archived_file_id 关联归档记录。
export const documentFacts = pgTable(
  "document_facts",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    project_id: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    archived_file_id: varchar("archived_file_id", { length: 36 }).references(
      () => archivedFiles.id,
      { onDelete: "set null" }
    ),
    source_fingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),
    fingerprint_kind: varchar("fingerprint_kind", { length: 32 }).notNull(),
    original_name: varchar("original_name", { length: 512 }).notNull(),
    storage_key: varchar("storage_key", { length: 1024 }),
    file_size: bigint("file_size", { mode: "number" }).default(0).notNull(),
    mime_type: varchar("mime_type", { length: 255 }).default("").notNull(),
    document_type: varchar("document_type", { length: 128 }).notNull(),
    raw_document_type: varchar("raw_document_type", { length: 255 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    document_number: varchar("document_number", { length: 255 }),
    version: varchar("version", { length: 255 }),
    document_dates: jsonb("document_dates").default(sql`'[]'::jsonb`).notNull(),
    parties: jsonb("parties").default(sql`'[]'::jsonb`).notNull(),
    sign_status: varchar("sign_status", { length: 32 }).notNull(),
    transaction_changes: jsonb("transaction_changes").default(sql`'[]'::jsonb`).notNull(),
    explicit_stage_clues: jsonb("explicit_stage_clues").default(sql`'[]'::jsonb`).notNull(),
    evidence_quotes: jsonb("evidence_quotes").default(sql`'[]'::jsonb`).notNull(),
    warnings: jsonb("warnings").default(sql`'[]'::jsonb`).notNull(),
    source_quality: varchar("source_quality", { length: 32 }).notNull(),
    extraction_confidence: integer("extraction_confidence").default(0).notNull(),
    extraction_status: varchar("extraction_status", { length: 32 }).notNull(),
    extraction_error: text("extraction_error"),
    extractor_version: varchar("extractor_version", { length: 64 }).notNull(),
    model_version: varchar("model_version", { length: 128 }).notNull(),
    facts_payload: jsonb("facts_payload").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("document_facts_project_fingerprint_uidx").on(
      table.project_id,
      table.source_fingerprint
    ),
    index("document_facts_archived_file_idx").on(table.archived_file_id),
    index("document_facts_type_idx").on(table.project_id, table.document_type),
  ]
);

// 分类决策：保留候选、证据、冲突、策略版本和人工纠正结果。
export const classificationDecisions = pgTable(
  "classification_decisions",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    project_id: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    archived_file_id: varchar("archived_file_id", { length: 36 }).references(
      () => archivedFiles.id,
      { onDelete: "set null" }
    ),
    document_fact_id: varchar("document_fact_id", { length: 36 }).references(
      () => documentFacts.id,
      { onDelete: "set null" }
    ),
    selected_category_id: varchar("selected_category_id", { length: 128 }),
    selected_category_name: varchar("selected_category_name", { length: 255 }),
    selected_folder_path: jsonb("selected_folder_path"),
    candidate_categories: jsonb("candidate_categories").default(sql`'[]'::jsonb`).notNull(),
    evidence: jsonb("evidence").default(sql`'[]'::jsonb`).notNull(),
    contradictions: jsonb("contradictions").default(sql`'[]'::jsonb`).notNull(),
    decision_score: integer("decision_score").default(0).notNull(),
    decision_source: varchar("decision_source", { length: 32 }).notNull(),
    reasoning: text("reasoning").default("").notNull(),
    model_version: varchar("model_version", { length: 128 }),
    policy_version: varchar("policy_version", { length: 64 }).notNull(),
    requires_review: boolean("requires_review").default(true).notNull(),
    review_status: varchar("review_status", { length: 32 }).default("pending").notNull(),
    corrected_category_id: varchar("corrected_category_id", { length: 128 }),
    corrected_category_name: varchar("corrected_category_name", { length: 255 }),
    corrected_folder_path: jsonb("corrected_folder_path"),
    correction_reason: text("correction_reason"),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("classification_decisions_project_idx").on(table.project_id),
    index("classification_decisions_review_idx").on(
      table.project_id,
      table.review_status
    ),
    index("classification_decisions_fact_idx").on(table.document_fact_id),
  ]
);

// 类型导出
export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;
export type ArchivedFile = typeof archivedFiles.$inferSelect;
export type InsertArchivedFile = typeof archivedFiles.$inferInsert;
export type ProjectContext = typeof projectContexts.$inferSelect;
export type InsertProjectContext = typeof projectContexts.$inferInsert;
export type ProjectEvent = typeof projectEvents.$inferSelect;
export type InsertProjectEvent = typeof projectEvents.$inferInsert;
export type DocumentFact = typeof documentFacts.$inferSelect;
export type InsertDocumentFact = typeof documentFacts.$inferInsert;
export type ClassificationDecision = typeof classificationDecisions.$inferSelect;
export type InsertClassificationDecision = typeof classificationDecisions.$inferInsert;
