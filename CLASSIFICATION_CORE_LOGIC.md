# 文件分类核心逻辑

本文档记录系统当前实际使用的文件分类逻辑。核心实现位于：

- `src/lib/classification.ts`：关键词评分、歧义判断、LLM 类别索引和置信度校验
- `src/app/api/classify/route.ts`：文件解析、两阶段分类、降级及自动归档流程
- `src/lib/folder-structure.ts`：档案目录、文件类别及关键词定义

## 一、整体流程

系统采用“关键词初筛 → AI 消歧 → 人工确认或自动归档”的流程：

1. 从文件名和文件内容中提取分类关键词。
2. 对所有档案类别计算关键词得分并排序。
3. 判断最高分是否达到阈值，以及与次高分是否有足够差距。
4. 关键词结果明确时，直接使用关键词分类。
5. 关键词得分不足、候选类别接近或文件为图片时，调用 LLM 分类。
6. LLM 结果达到置信度阈值时，采用其类别，但归档前要求人工确认。
7. LLM 结果不可靠时，暂用关键词最佳结果，并要求人工确认分类位置。
8. 关键词和 LLM 均无法提供候选类别时，返回未分类结果。

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

重要边界：当前 shadow 结果不参与关键词得分、LLM 类别选择或自动归档。启用后会增加一次模型调用，主要用于使用君柔评测集验证事实完整度。

### Shadow mode：项目记忆持久化

执行 `src/storage/database/migrations/0001_agent_context.sql` 后，可以启用：

```text
单次请求：persistFacts=true
全局启用：PERSIST_PROJECT_MEMORY_SHADOW=true
```

当前 Coze 开发环境未执行项目记忆表迁移，因此禁止使用 `persistFacts=true`，也禁止设置 `PERSIST_PROJECT_MEMORY_SHADOW=true`。持久化只在最终自有 Supabase 完成建表后启用。

### Shadow mode：上下文决策

`src/lib/classification/context-decision.ts` 实现了第三版内存型上下文决策器。调用 `/api/classify` 时传入 `contextDecision=true` 会自动启用文档事实抽取，并可同时传入：

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

第三版在上述规则之外增加通用文档类型候选映射，并用项目事件直接关联的阶段校验同名或相似类别。当前已覆盖增资协议、股东协议、董事会/投委会决议、银行回单、立项申请/报告、商业计划书、尽调报告、表决票、营业执照、财务材料、保密协议、出资证明和股东名册等类型；无法唯一决定时仍转人工。

### Shadow mode：项目上下文综合

`src/lib/classification/project-context-synthesizer.ts` 实现 `project-context-synthesizer-v1`：

1. 每次项目文件新增、替换或删除后，读取当前全部有效结构化事实卡片；
2. 调用一次 Coze LLM 重建项目事件时间线、阶段假设、文件关系、冲突和待确认问题；
3. 不使用上传顺序推断业务发生顺序，项目最晚证据阶段也不能直接决定单份历史文件的阶段；
4. 每个事件必须引用当前项目中真实存在的 `sourcePath`，无有效来源的事件会被丢弃；
5. 模型失败时使用确定性事件映射生成带警告的降级快照，不阻断原分类；
6. 新快照写入 Coze S3 项目记忆，并触发项目内全部文件重新执行 Agent Shadow 建议；
7. 上下文综合 LLM 调用次数单独展示，不计入 LangGraph 调度层的 `llmCallCount`。

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

当前 Agent 调度层的 `llmCallCount` 固定为 0：LangGraph 负责工作流和工具调度，前置事实抽取器才可能调用一次 Coze LLM。Agent 仍为 shadow mode，不修改 legacy `category`，不触发额外归档；项目事实写入 Coze S3，但不写入 Supabase 业务表。

### Shadow mode：会话项目记忆

`src/lib/classification/session-project-memory.ts` 为线上开发阶段提供不依赖 Supabase 的持久化项目记忆。启用 `agentDecision=true` 且请求包含有效 `projectId` 时，分类 API 会：

1. 按 `projectId` 隔离保存当前文件的结构化事实；
2. 按规范化 `sourcePath` 幂等更新同一文件；
3. 自动把同项目已上传文件作为 Agent 的关联事实，并展示每份事实的文档类型、完整度、来源和警告；
4. 新证据到达后先重建项目上下文，再重新评估项目内全部文件；公司章程继续使用注册资本和交易前后版本规则作为确定性安全校验；
5. 将重新判断结果返回给前端，更新历史文件的 Agent Shadow 卡片；
6. 以追加版本记录写入 Coze S3，服务重启、重新部署和多实例切换后可恢复；
7. 取消待归档文件或删除单个归档文件时写入 tombstone；删除项目时同步清除该项目的 S3 记忆与进程缓存。

因此顺序上传和乱序上传都受支持：按业务顺序上传可以逐步积累上下文；项目结束后乱序导入时，系统会在新证据出现后回看旧文件，而不是把上传顺序当作业务阶段。

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
