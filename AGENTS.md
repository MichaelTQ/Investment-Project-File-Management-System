# 投资项目档案管理系统

## 项目概览
基于 Next.js 16 的智能投资项目档案管理系统，支持文件上传、自动分类和归档建议。遵循《国创致远-投资项目档案管理》文档规范。采用 Supabase（数据库）+ S3 对象存储实现跨设备同步。

## 规划文档

- `NEXT_STAGE_AGENT_IMPLEMENTATION_PLAN.md`：下一阶段上下文感知分类、项目状态建模、LangGraph 工作流、疑难 Agent、人工确认、评测与灰度上线的实施依据。后续涉及分类架构或 Agent 开发时，应先阅读该文档。
- `CLASSIFICATION_CORE_LOGIC.md`：当前已经实现的文件分类逻辑。规划文档描述目标状态，本文件描述当前状态，不得混淆。

## 技术栈
- **框架**: Next.js 16 (App Router)
- **语言**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **样式**: Tailwind CSS 4
- **AI 能力**: coze-coding-dev-sdk (LLM + FetchClient)
- **Agent 编排**: @langchain/langgraph（状态图、条件路由、证据检索循环）
- **数据库**: Supabase (Drizzle ORM)
- **文件存储**: S3 兼容对象存储 (coze-coding-dev-sdk StorageClient)

## 文件结构
```
src/
├── app/
│   ├── api/
│   │   ├── classify/route.ts        # 文件分类 + 自动归档 API
│   │   ├── projects/route.ts        # 项目管理 CRUD API
│   │   ├── archive/route.ts         # 归档文件查询/下载/删除 API
│   │   └── archive/download-all/route.ts  # 一键下载 ZIP API
│   ├── layout.tsx                    # 根布局
│   └── page.tsx                      # 主页面（三栏布局）
├── components/ui/                    # shadcn/ui 组件库
├── lib/
│   ├── folder-structure.ts           # 文件夹结构定义 + 类型
│   ├── classification/
│   │   ├── document-facts.ts         # 文档事实 Schema + 字段校正/安全降级
│   │   ├── fact-extractor.ts         # 文档事实 LLM 抽取器（shadow mode）
│   │   ├── context-decision.ts       # 项目上下文证据决策器
│   │   ├── classification-agent.ts   # LangGraph 分类 Agent（shadow mode）
│   │   ├── session-project-memory.ts # 项目记忆编排、诊断与降级缓存
│   │   └── durable-project-memory.ts # Coze S3 项目快照、版本校验与旧历史压缩
│   ├── project-memory.ts             # 项目上下文、事件、文档事实和分类决策存储层
│   └── storage.ts                    # 统一存储层（Supabase + S3）
├── storage/
│   └── database/
│       ├── shared/schema.ts          # Drizzle schema（业务表 + 项目记忆表）
│       ├── migrations/               # Supabase SQL 迁移
│       └── supabase-client.ts        # Supabase 客户端初始化
└── hooks/                            # React Hooks
```

## 核心模块说明

### folder-structure.ts
- **FOLDER_STRUCTURE**: 只包含 8 个业务阶段归档文件夹的树形结构
- **SYSTEM_ARCHIVE_FOLDERS**: 阶段文件夹扁平列表；自动分类只能选择这些系统文件夹
- **FolderNode / ArchiveFolder**: 文件夹节点与最终归档目标接口
- **Project / ArchivedFile**: 项目与归档文件接口

### storage.ts（统一存储层）
- **createProject / listProjects / deleteProject**: 项目管理（Supabase）
- **archiveFile**: 文件归档（上传 S3 → 写入 Supabase）
- **listArchivedFiles / getArchivedFile / deleteArchivedFile**: 归档文件 CRUD
- **getFileDownloadUrl / getFileDownloadStream**: 文件下载（S3 签名 URL / 流式）
- **getAllFileDownloadStreams**: 批量获取文件流（用于 ZIP 打包）
- **buildArchiveTree**: 将归档文件列表构建为树形结构

### api/classify/route.ts
- **POST**: 处理文件上传和智能分类
- 先抽取文档事实，再判断 `businessStage`，最后一一映射为 `targetFolder`
- 支持 PDF、Word、Excel、PPT、TXT 等格式
- 支持 `projectId` 和 `autoArchive` 参数，分类后自动归档
- 支持 `extractFacts=true` 或环境变量 `ENABLE_DOCUMENT_FACTS_SHADOW=true`，返回结构化文档事实并供阶段决策使用
- 支持 `persistFacts=true` 或 `PERSIST_PROJECT_MEMORY_SHADOW=true`，将事实和当前 legacy 分类决策写入项目记忆表；持久化失败不会阻断原分类
- 支持 `contextDecision=true` 运行非持久化上下文决策器，可接收 `sourcePath`、`projectContext` 和 `relatedDocumentFacts`；当前只作 shadow 对比，不修改原分类或自动归档
- 支持 `agentDecision=true` 或 `ENABLE_CLASSIFICATION_AGENT_SHADOW=true` 运行 LangGraph Agent，返回建议、证据、冲突和节点轨迹；Agent 调度层当前不调用 LLM
- Agent shadow 请求具有有效 `projectId` 时自动使用 Coze S3 持久化项目记忆；关联章程、股东会决议和增资协议可触发历史章程重新判断，结果不写入 Supabase
- 项目记忆使用逻辑 `snapshot` 与轻量 `revision` 对象；物理对象使用 Coze 上传返回的真实随机后缀 key，版本未变化时复用进程缓存，旧追加式历史只在快照验证成功后清理
- 分类与归档响应包含分阶段耗时和 LLM 输入/输出诊断，Context/事实/OCR 输出上限分别为 3072/2048/1200 tokens

### page.tsx（主页面组件）
- **三栏布局**: 项目管理+文件夹结构 | 上传+分类结果 | 归档文件树+分析记录
- **项目管理**: 支持分页、新增动画、删除确认
- **归档文件树**: 按阶段文件夹和用户自建子文件夹展示，支持展开/折叠、下载、删除
- **一键下载全部**: 打包为 ZIP 保留完整文件夹结构
- **分析记录面板**: 显示上传时间、原始文件名、归档后文件名、分类路径
- **Agent Shadow 面板**: 在分类详情中展示 Agent 建议、证据、冲突、关联文件、执行轨迹和人工复核状态
- **项目记忆提示**: 展示持久化状态、项目文件数、事实类型与质量、可用关联事实及被新证据重新判断的历史文件

## 文件分类逻辑
1. **事实抽取**: 识别 `documentType`、标题、日期、主体和交易变化
2. **阶段判断**: 用文件自身证据、项目 Context 和关联文件判断 `businessStage`
3. **文件夹映射**: 阶段一一映射为 `folderId`，不再选择细分文件类型
4. **人工确认**: Agent 主模式确认目标阶段文件夹和 `archiveTitle` 后归档

## 文件夹结构（阶段文件夹）
```
投资项目档案/
├── 基金投资及投资执行/
│   ├── 立项前/
│   ├── 项目立项/
│   ├── 尽职调查/
│   ├── 投资决策/
│   └── 投资实施/
├── 投后管理/
└── 项目退出/
    ├── 退出决策/
    └── 退出执行/
```

## API 接口

### POST /api/classify
上传文件进行智能分类并自动归档。

**请求**: `multipart/form-data`
- `file`: 文件（PDF/Word/Excel/PPT/TXT）
- `projectId`: 项目 ID（可选）
- `autoArchive`: 是否自动归档（默认 true）

**响应**:
```json
{
  "fileName": "string",
  "fileSize": number,
  "targetFolder": { "folderPath": ["string"], "folderId": "string", "name": "string", "businessStage": "string" },
  "confidence": number,
  "reasoning": "string",
  "contentPreview": "string",
  "process": { "step0_businessStage": {...}, "finalDecision": {...} },
  "archived": { "id": "string", "archivedName": "string", "projectName": "string", "folderPath": ["string"] }
}
```

### GET/POST/DELETE /api/projects
项目管理 CRUD。

### GET /api/archive
- `?projectId=xxx&tree=true` - 获取归档文件树形结构
- `?download=xxx&id=xxx` - 获取文件下载签名 URL
- `?id=xxx` - 流式下载单个文件

### GET /api/archive/download-all?projectId=xxx
一键下载全部归档文件为 ZIP（保留文件夹结构）。

### DELETE /api/archive?id=xxx
删除归档文件（同时删除 S3 文件和数据库记录）。

## 数据库表

### projects
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| name | text | 项目名称 |
| description | text | 项目描述 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### archived_files
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| original_name | text | 原始文件名 |
| archived_name | text | 归档后文件名 |
| project_id | UUID | 关联项目 |
| project_name | text | 项目名称 |
| category_id | text | 兼容物理列，当前承载 folderId |
| category_name | text | 兼容物理列，当前承载路径末级名称 |
| folder_path | jsonb | 文件夹路径数组 |
| file_size | int8 | 文件大小 |
| mime_type | text | MIME 类型 |
| storage_key | text | S3 对象存储 key |
| confidence | int4 | 分类置信度 |
| reasoning | text | 分类理由 |
| archived_at | timestamptz | 归档时间 |

### 项目记忆表

- `project_contexts`：项目阶段、目标公司、投资方、关键日期和上下文版本；
- `project_events`：投决、签约、股东会、交割和付款等带证据的业务事件；
- `document_facts`：允许预归档创建的结构化事实，按项目和源指纹幂等 upsert；
- `classification_decisions`：候选、证据、冲突、策略版本、复核状态和人工纠正。

### 已验收的试点标签

- 君柔试点的 6 个核心分类用例已于 2026-08-01 通过业务验收；
- “投资合规性审查表”归入“投资决策”阶段文件夹，在积累更多项目样本前默认需人工复核。

## 运行命令
- `pnpm dev`: 启动开发环境
- `pnpm build`: 构建生产版本
- `pnpm start`: 启动生产环境
- `pnpm lint`: 代码检查
- `pnpm ts-check`: TypeScript 类型检查

## 环境变量
- `DEPLOY_RUN_PORT`: 服务监听端口（默认 5000）
- `COZE_PROJECT_DOMAIN_DEFAULT`: 对外访问域名
- `COZE_BUCKET_ENDPOINT_URL`: S3 对象存储端点
- `COZE_BUCKET_NAME`: S3 存储桶名称
- `ENABLE_DOCUMENT_FACTS_SHADOW`: 是否默认启用结构化文档事实抽取（默认关闭）
- `ENABLE_CLASSIFICATION_AGENT_SHADOW`: 是否默认运行 LangGraph 分类 Agent（默认关闭）
- `PERSIST_PROJECT_MEMORY_SHADOW`: 是否将 shadow 事实和分类决策写入 Supabase（默认关闭；启用前必须执行 `0001_agent_context.sql`）

### 开发环境约束

- 当前继续使用 Coze 代管环境，不修改其 Supabase 数据库结构；
- 开发阶段不得开启 `PERSIST_PROJECT_MEMORY_SHADOW`；
- Agent 项目记忆以 Coze S3 持久化 shadow mode 和本地 fixtures 验证；
- Agent 当前只生成结构化建议和执行轨迹，不接管 legacy 分类、自动归档或数据库写入；
- Coze S3 通过项目快照保存当前有效事实并支持重启、重新部署和多实例恢复；轻量版本号未变化时复用进程缓存，S3 故障时才降级为最长空闲 12 小时的进程缓存；
- 最终上线时再创建自有 Supabase，并执行完整数据库初始化与迁移。

## 依赖说明
- `coze-coding-dev-sdk`: 提供 LLM、文件解析、对象存储能力
  - `LLMClient`: 大语言模型调用
  - `FetchClient`: 文件内容提取
  - `S3Storage`: S3 对象存储操作
  - `HeaderUtils`: 请求头提取
- `@supabase/supabase-js`: Supabase 客户端
- `drizzle-orm`: 数据库 ORM
