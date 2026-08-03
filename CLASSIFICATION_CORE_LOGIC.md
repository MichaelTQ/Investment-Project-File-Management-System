# 文件分类核心逻辑

本文档记录系统当前实际使用的文件分类逻辑。核心实现位于：

- `src/lib/classification.ts`：关键词评分、歧义判断、LLM 类别索引和置信度校验
- `src/app/api/classify/route.ts`：文件解析、两阶段分类、降级及自动归档流程
- `src/lib/folder-structure.ts`：档案目录、文件类别及关键词定义

## 一、整体流程

分类 API 保留传统分类链路，但主页面默认采用“结构化事实抽取 → 项目 Context → Agent 建议 → 人工确认归档”的流程。用户可打开“显示传统分类”开关，让后续上传同时运行传统分类并与 Agent 结果并列对照。

当前分类采用“阶段优先、目录锁定、类型开放”的字段分工：

| 字段 | 唯一职责 |
|---|---|
| `businessStage` | 文件属于哪个业务阶段 |
| `folderId` | 文件最终放入哪个物理目录 |
| `documentType` | 文件客观上是什么，不直接决定目录 |
| `archiveTitle` | 文件归档后叫什么，不参与目录判断 |

`categoryId` 是历史兼容字段，当前实际值仍等于 `folderId`；`categoryName` 是历史展示标签。新决策不能再用 `categoryName` 在全局目录中反查位置。

### 阶段安全原则

1. 先根据当前文件事实、明确措辞、项目事件和关联文件判断 `businessStage`。
2. 阶段明确后，只能在该阶段对应的目录范围内选择 `folderId`。
3. 阶段内存在准确细分目录时，选择该目录。
4. 阶段明确但没有准确细分类型时，直接使用该阶段的安全兜底分类目标；兜底目标不会创建额外物理子目录。
5. 阶段无法确定或多个阶段冲突时转人工，不得因为其他阶段存在同名文件类型而跨阶段归档。
6. 阶段兜底结果可以作为人工确认的默认建议，但默认要求人工复核。

例如 `documentType=voting_result`：

- 正文明确“通过立项”时，锁定 `businessStage=initiation`；若没有“立项表决结果”细分类型，则归入 `folderId=project-initiation`，展示标签为“其他立项材料”。
- 正文明确“投资决策委员会表决”时，锁定 `investment_decision`，可归入 `decision-documents / 表决票`。
- 正文明确“退出表决”时，锁定 `exit_decision`，可归入 `exit-decision-docs / 退出表决票`。

传统分类链路为：

1. 先运行 `business-stage.ts` 判断业务阶段。
2. 阶段明确时，将关键词和 LLM 候选限制在该阶段；阶段不明时仅保留全量关键词诊断，不形成传统分类或 Agent 自主建议。
3. 从文件名和文件内容中提取分类关键词并在允许范围内评分。
4. 判断最高分是否达到阈值，以及与次高分是否有足够差距。
5. 关键词结果明确时使用该结果。
6. 关键词不足、候选接近或文件为图片时调用 LLM；LLM 提示会明确阶段锁定，并要求无准确细分类型时选择同阶段“其他材料”。
7. LLM 结果达到置信度阈值时采用其建议，但归档前要求人工确认。
8. 阶段或分类仍不可靠时转人工，不跨阶段寻找同名文件类型。

主页面的默认 Agent 模式：

1. 请求 `/api/classify` 时传入 `agentDecision=true`、`legacyDecision=false` 和 `autoArchive=false`；
2. 服务端跳过传统关键词/LLM 分类决策，使用最新正式 Context 运行 Agent；
3. Agent 建议直接显示在外层结果卡片，并作为人工归档确认的默认分类；
4. Agent 证据不足时不猜测，用户需要手动选择最终归档位置；
5. 只有人工确认并归档成功后，文件事实才进入正式项目 Context；
6. 打开传统分类对照开关后，后续上传改为 `legacyDecision=true`，外层并列展示两套结果和差异提示。

## 二、文件内容提取

不同文件类型使用不同的内容提取方式：

- TXT、Markdown、CSV、JSON、XML：直接按 UTF-8 解码。
- PDF、Word、Excel、PowerPoint：通过 `FetchClient` 提取文字。
- 图片：将原始图片交给多模态 LLM 分析。
- 扫描 PDF：当提取文字少于 30 个字符时，最多选取 12 页页面图片，分批进行视觉文字提取。
- 文件解析失败：退化为仅使用原始文件名进行分类。

### Shadow mode：结构化文档事实抽取

系统已经加入独立的文档事实层：

- `src/lib/classification/document-facts.ts`：定义严格的 `DocumentFactsSchema`、局部字段校正、JSON 安全解析和零置信度降级结果；非标准日期、缺失数组或超长字段会保留其余事实并记录校正警告；
- `src/lib/classification/fact-extractor.ts`：调用 LLM 提取文件类型、标题、日期、主体、签署状态、交易变化和证据；
- `src/app/api/classify/route.ts`：通过 shadow mode 可选调用事实抽取器。

启用方式：

```text
单次请求：extractFacts=true
全局启用：ENABLE_DOCUMENT_FACTS_SHADOW=true
```

当前事实结果会作为 `documentFacts` 返回，并在 `process.step0_factExtraction` 中记录 `success` 或 `fallback`。事实抽取失败时返回 `documentType=unknown`、`extractionConfidence=0`，不会阻断原分类流程。

重要边界：结构化事实会参与 Agent 的阶段判断和上下文建议，但不参与 legacy 关键词得分，也不会扩大 legacy 自动归档权限。传统链路的阶段判断只读取原始文件名和正文；Agent-first 仍强制人工确认后才能正式归档。

### Shadow mode：项目记忆持久化

执行 `src/storage/database/migrations/0001_agent_context.sql` 后，可以启用：

```text
单次请求：persistFacts=true
全局启用：PERSIST_PROJECT_MEMORY_SHADOW=true
```

当前 Coze 开发环境未执行项目记忆表迁移，因此禁止使用 `persistFacts=true`，也禁止设置 `PERSIST_PROJECT_MEMORY_SHADOW=true`。持久化只在最终自有 Supabase 完成建表后启用。

### Shadow mode：上下文决策

`src/lib/classification/context-decision.ts` 实现了第四版内存型上下文决策器，`src/lib/classification/business-stage.ts` 负责独立的阶段证据评分。调用 `/api/classify` 时传入 `contextDecision=true` 会自动启用文档事实抽取，并可同时传入：

- `sourcePath`：文件在项目档案中的原始相对路径；
- `projectContext`：符合 `ProjectContextSnapshotSchema` 的项目阶段与时间线快照；
- `relatedDocumentFacts`：同项目关联文件的 `sourcePath + DocumentFacts` 列表。

返回的 `contextDecision` 包含候选得分、决定性证据、冲突、策略版本和人工复核标记。当前它与 legacy 分类结果并列返回，不修改 `category`、`confidence` 或自动归档结果。

原有试点规则继续覆盖：

- 根据注册资本、股东变化、有效日期、项目事件和关联章程对比，区分交易前公司章程和投资实施阶段项目公司章程；
- 根据正式标题、管理人意见、投资限制审查和项目事件，识别投资合规性审查表；
- 根据目标公司股东会身份、增资批准事项和项目事件，识别投资实施阶段股东会决议，并排除基金投委会决议；
- 根据交割确认标题、交割条件和增资协议引用，识别确权文件，并排除付款通知、银行回单和退出交割；
- 根据缴款通知标题、付款指令和交易协议引用，识别付款通知函，并排除银行回单和退出付款；
- 项目“当前阶段”只是弱先验，不能单独把后补上传的历史文件归入当前阶段。

第四版在上述规则之外执行以下通用约束：

- 文档类型、业务阶段和归档目录分别建模；
- 当前文件中的明确阶段措辞权重大于项目最新阶段，避免历史文件补传时被当前阶段覆盖；
- 阶段明确后，通用候选只从该阶段目录中生成；
- 文档类型在该阶段没有对应细分类时，由 `STAGE_FALLBACK_CATEGORIES` 生成同阶段安全兜底目标；
- `routingMethod=safe_stage_fallback` 时保留默认建议并要求人工复核；
- `businessStage` 无法确定时返回 `needs_stage_review`，不使用全局同名类别猜测目录；
- Agent 检索到的关联文件会作为阶段证据参与后续轮次，不再只出现在执行轨迹中。

当前通用映射继续覆盖增资协议、股东协议、董事会/投委会决议、银行回单、立项申请/报告、商业计划书、尽调报告、表决结果、营业执照、财务材料、保密协议、出资证明和股东名册等类型，但映射只能在已锁定阶段内选择目录。

### Shadow mode：项目上下文综合

`src/lib/classification/project-context-synthesizer.ts` 实现 `project-context-synthesizer-v1`：

1. 只读取已经正式归档且未删除的结构化事实卡片；待归档候选不进入 Context；
2. 正式归档成功后调用一次 Coze LLM，重建项目事件时间线、阶段假设、文件关系、冲突和待确认问题，并产生新的 Context 版本；
3. 不使用上传顺序推断业务发生顺序，项目最晚证据阶段也不能直接决定单份历史文件的阶段；
4. 每个事件必须引用当前项目中真实存在的 `sourcePath`，无有效来源的事件会被丢弃；
5. 模型失败时保留上一版 Context 并标记为 `failed`，不让不完整的新快照覆盖已提交版本；
6. 新快照写入 Coze S3 项目记忆，并触发项目内全部文件重新执行 Agent Shadow 建议；
7. 移动或删除归档文件时只写入变更并把 Context 标记为 `dirty`，不会立即调用 LLM；
8. 用户可在“项目 Context”面板手动刷新；若没有手动刷新，下一份新文件判断前会自动刷新；
9. 上下文综合 LLM 调用次数单独展示，不计入 LangGraph 调度层的 `llmCallCount`。

### Shadow mode：LangGraph 分类 Agent

`src/lib/classification/classification-agent.ts` 已使用 `@langchain/langgraph` 实现第一版可执行状态图。它不是再写一个更长的 Prompt，而是用共享状态、节点和条件边组织以下流程：

```text
证据规划
→ 按文档类型决定是否检索关联文件
→ 上下文决策
→ 证据不足时继续检索或转人工
→ 有充分证据时完成建议
```

当前节点包括 `plan_evidence`、`retrieve_related_document`、`context_decision`、`complete` 和 `human_review`。关联文件不再仅按公司章程特例选择，而是按项目事件共现、文件关系、配套文档类型、共同主体和交易字段进行相关度排序；合规审查表即使得出分类建议，也会遵守类别策略转人工；尚无规则的文件不会让模型猜测。

启用方式：

```text
单次请求：agentDecision=true
全局启用：ENABLE_CLASSIFICATION_AGENT_SHADOW=true
```

请求可同时提供 `sourcePath`、`projectContext` 和 `relatedDocumentFacts`。返回值包含 `agentDecision` 及 `process.step0_agentOrchestration`，可查看最终状态、检索轮数、节点轨迹和调度层模型调用数。

当前 Agent 调度层的 `llmCallCount` 固定为 0：LangGraph 负责工作流和工具调度，前置事实抽取器才可能调用一次 Coze LLM。Agent 不触发自动归档；项目事实写入 Coze S3，但不写入 Supabase 业务表。在双轨对照模式中，Agent 与传统分类结果仍分别保存和展示，不会互相覆盖。

主页面已进入 Agent-first 展示模式：传统分类开关默认关闭，此时 API 跳过传统分类决策，并把 Agent 建议作为顶层展示结果；打开开关后，下一次上传才同时运行并列对照。这里的 Shadow 边界指 Agent 仍不能自行写入档案或绕过人工确认，并不再表示 Agent 结果只能藏在详情弹窗中。

### Shadow mode：会话项目记忆

`src/lib/classification/session-project-memory.ts` 为线上开发阶段提供不依赖 Supabase 的持久化项目记忆。启用 `agentDecision=true` 且请求包含有效 `projectId` 时，分类 API 会：

1. 按 `projectId` 隔离加载最新已提交 Context 和已归档文件事实；
2. 若 Context 是 `dirty` 或 `failed`，在判断新候选前先自动刷新；
3. 使用该版本 Context 和关联事实判断当前候选，但不把候选提前写入项目记忆；
4. 记录本次判断实际使用的 `decisionContextVersion`，前端可见；
5. 只有归档成功后，才按规范化 `sourcePath` 幂等提交事实、关联 `archivedFileId` 并生成新 Context 版本；
6. 新版本产生后重新评估项目内全部已提交文件，并把变化返回前端；
7. 以追加版本记录写入 Coze S3，服务重启、重新部署和多实例切换后可恢复；
8. 删除单个归档文件时写入精确到 `archivedFileId` 的 tombstone，移动或删除后只标记 Context `dirty`；删除项目时同步清除该项目的 S3 记忆与进程缓存。

因此顺序上传和乱序上传都受支持：按业务顺序上传可以逐步积累 Context；项目结束后乱序导入时，系统会在新证据正式归档后回看旧文件，而不是把上传顺序当作业务阶段。

项目记忆的边界：

- 正常情况下持久保存于 Coze S3，不再受 12 小时、50 个项目或每项目 200 份文件的内存限制；
- S3 暂时不可用时自动降级为当前进程缓存，该降级缓存仍有 12 小时、50 个项目和每项目 200 份文件限制，界面会明确告警；
- 使用不可变追加记录避免多实例写入相互覆盖；同时到达的请求可能要到下一次读取时才汇合全部上下文；
- 不写入 Supabase 业务表；最终上线后的自有 Supabase 仍用于结构化检索、审核状态、权限与统计；
- 仍只更新 Agent Shadow 建议，不覆盖 legacy 正式分类和归档结果。

持久化行为包括：

1. 优先使用文件内容 SHA-256；无法直接读取 Buffer 时使用存储身份生成源指纹；
2. 按 `(project_id, source_fingerprint)` 幂等 upsert `document_facts`；
3. 正式归档成功后，将事实记录关联到 `archived_files.id`；
4. 将当前 legacy 分类器的候选和结论写入 `classification_decisions`，策略版本为 `legacy-classification-v1`；
5. 持久化失败只记录在 `process` 中，不改变原分类或归档结果。

`persistFacts=true` 会自动启用事实抽取，并且必须提供有效 `projectId`。数据库迁移应用前不得打开全局持久化开关。

## 三、关键词评分

### 1. 基础权重

| 命中位置 | 每个有效关键词得分 |
|---|---:|
| 文件名 | 3 分 |
| 文件内容 | 1 分 |

关键词匹配不区分英文大小写，并使用 Unicode NFKC 规范化处理。

### 2. 去重与嵌套词处理

同一类别内：

- 完全重复的关键词只计算一次。
- 多个命中词存在包含关系时，只保留更具体、长度更长的关键词。

例如关键词为“立项”“申请”“立项申请”时，文件名“立项申请.pdf”只按“立项申请”计 3 分，不会累计为 9 分。

### 3. 关键词通过条件

当前常量为：

```text
关键词最低得分：5 分
最高分与次高分最小差距：2 分
```

只有同时满足以下条件，关键词分类才算明确：

1. 最高分大于或等于 5 分。
2. 不存在次高分，或者最高分至少领先次高分 2 分。

若最高分达到阈值，但领先不足 2 分，则标记为歧义并进入 AI 消歧，不能依靠目录定义顺序决定结果。

### 4. 关键词置信度

关键词结果的置信度按以下方式计算：

```text
置信度 = min(关键词得分 × 10, 95)
```

关键词置信度最高为 95%。

## 四、LLM 分类

LLM 接收以下信息：

- 当前项目名称
- 原始文件名
- 提取内容的前 2000 字
- 所有可选类别的完整目录路径、类别名称和关键词
- 图片文件的原始视觉内容

LLM 必须从给定类别中选择，不允许创建新类别，并返回：

```json
{
  "categoryIndex": 1,
  "confidence": 80,
  "reasoning": "分类依据",
  "suggestedArchiveTitle": "建议档案标题"
}
```

### 1. 类别映射

系统直接使用 `categoryIndex` 映射到完整的 `FlatFileCategory` 对象，不再通过类别名称反向搜索。

这样可以正确区分不同目录下的同名类别，例如：

- 基金投资及投资执行 / 投资实施 / 转账凭证
- 项目退出 / 退出执行 / 转账凭证

非法、非整数或超出范围的类别索引会被视为无效结果。

### 2. LLM 置信度

LLM 置信度会：

1. 转换为数字。
2. 四舍五入为整数。
3. 限制在 0 到 100 之间。
4. 无法转换时按 0 处理。

当前 LLM 接受阈值为 60%。只有类别索引有效且置信度大于或等于 60%，才采用 LLM 类别。

## 五、最终决策

### 1. 关键词直接分类

当关键词结果达到得分和领先差距要求时：

- 使用关键词最高分对应的类别。
- 不要求人工确认。
- 请求启用自动归档且项目有效时，直接归档。

### 2. LLM 分类

当关键词存在歧义、得分不足或文件是图片，并且 LLM 置信度达到 60% 时：

- 使用 LLM 的精确类别索引。
- 使用 LLM 提供的建议档案标题。
- 要求用户确认分类位置和档案标题后归档。

### 3. 降级分类

当 LLM 失败、类别索引无效或置信度低于 60%，但仍有关键词候选时：

- 暂用关键词最高分结果。
- 标记为降级分类。
- 必须由用户确认或修改分类位置和档案标题。
- 不会自动归档。

### 4. 无法分类

当关键词没有任何候选，且 LLM 也没有可靠结果时：

- 返回 `category: null`。
- 置信度为 0。
- 文件不会归档。

## 六、人工确认

需要确认的结果会在界面中提供：

- 完整归档类别选择器
- 建议档案标题输入框
- 确认归档和取消归档操作

用户选择的新类别会以 `folderId + fileName + folderPath` 在归档接口中重新校验，避免提交不存在或被篡改的分类。

## 七、典型消歧示例

### 退出投委会决议

文件名“退出投委会决议.pdf”中：

- 普通“投委会决议”只保留最具体的“投委会决议”命中。
- “退出投委会决议”类别可同时识别“退出”“投委会”“决议”。

因此退出类别得分更高，不再因目录顺序误入普通投资决策目录。

### 未注明阶段的转账凭证

文件名“转账凭证.pdf”会同时匹配投资实施和退出执行中的“转账凭证”，且得分相同。

系统会将其标记为歧义并调用 LLM，而不是默认选择目录中靠前的类别。

### 项目公司章程

文件名“项目公司章程.pdf”不会把“章程”“公司章程”“项目公司章程”重复累计。若候选类别得分接近，则进入 AI 消歧和人工确认。

### 投资合规性审查表

该类别归入“基金投资及投资执行 / 投资决策 / 上会材料”。文件需至少有正式合规审查表标题，或有子基金管理人针对具体投资项目出具的合规审查意见。

仅出现一般性“合规”字样不足以归类。法律尽调报告、投后合规检查和没有独立合规审查结构的投资建议书属于排除项。在累积更多项目样本前，该类别默认需人工复核。可执行规则见 `src/lib/classification/category-policies.ts`。

## 八、自动归档条件

只有同时满足以下条件才会自动归档：

1. 请求中的 `autoArchive` 为 `true`。
2. 提供了有效项目 ID，且项目存在。
3. 最终分类不为空。
4. 分类结果不要求人工确认。

当前明确通过关键词判定的结果原则上可以直接自动归档，但若该类别的证据策略设置了 `defaultRequiresHumanReview`，仍必须人工确认。LLM 分类和降级分类也均需人工确认。

## 九、回归测试

分类回归测试位于 `tests/classification.test.ts`，运行命令：

```bash
pnpm test:classification
pnpm test:agent
pnpm test:agent-report
pnpm test:context
pnpm test:shadow-report
```

重新生成君柔真实文件 shadow 报告（仅 macOS 本地评测，使用 Vision OCR）：

```bash
pnpm evaluate:junrou-shadow
pnpm evaluate:junrou-agent
```

测试覆盖：

- 重复及嵌套关键词去重
- 退出投委会决议消歧
- 两类转账凭证并列处理
- 项目公司章程嵌套关键词处理
- 最高分并列时进入 AI
- LLM 同名类别索引映射
- LLM 置信度校验
- 投资合规性审查表识别与人工复核策略
- 交易前/增资后章程的关联事实消歧
- 项目当前阶段不能单独决定历史文件位置
- 上下文输入 Schema 校验和证据不足降级
- Agent 根据文档类型动态选择关联文件和执行路径
- Agent 多轮检索、明确终止、规则未覆盖时安全转人工
- 君柔 Agent 报告中明确建议 6/6 命中且错误自主建议为 0
