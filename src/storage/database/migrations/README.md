# 项目记忆数据库迁移

## 当前执行决策

开发阶段继续使用 Coze 代管的现有环境，不在该环境执行本目录中的 SQL 迁移。`PERSIST_PROJECT_MEMORY_SHADOW` 必须保持关闭。

本目录的迁移文件保留给最终真实上线时的自有 Supabase。当前 Agent 开发使用非持久化 shadow mode 和本地评测 fixtures，不依赖新表存在。

## 迁移文件

- `0001_agent_context.sql`：新增 `project_contexts`、`project_events`、`document_facts` 和 `classification_decisions`。

## 应用顺序

以下步骤仅在最终真实上线、且已创建自有 Supabase 后执行：

1. 确认目标 Supabase 已存在 `projects` 和 `archived_files`；
2. 在 Supabase SQL Editor 或既有迁移流程中执行 `0001_agent_context.sql`；
3. 确认四张表及索引创建成功；
4. 先使用单次请求 `persistFacts=true` 做 shadow 验证；
5. 验证成功后再设置 `PERSIST_PROJECT_MEMORY_SHADOW=true`。

应用迁移前不要打开持久化环境开关。代码会捕获持久化错误并继续原分类流程，但数据库不会产生项目记忆记录。

## 回滚原则

迁移只新增表，不修改 `projects` 和 `archived_files`。如需回滚，应先导出 shadow 数据，再按依赖顺序删除：

```text
classification_decisions
document_facts
project_events
project_contexts
```

不要在生产环境中未经备份直接删除这些表。
