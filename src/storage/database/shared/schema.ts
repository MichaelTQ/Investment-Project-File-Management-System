import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

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

// 类型导出
export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;
export type ArchivedFile = typeof archivedFiles.$inferSelect;
export type InsertArchivedFile = typeof archivedFiles.$inferInsert;
