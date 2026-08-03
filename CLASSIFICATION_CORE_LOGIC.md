# 文件归档核心逻辑（v5：阶段文件夹模型）

> 本文件覆盖旧版“50+ 细分类别、关键词选叶子类别、安全兜底类别”的记录，描述当前实际代码。最后更新：2026-08-03。

## 先看一句话

系统现在只回答一个归档问题：

**这份文件属于哪个业务阶段文件夹？**

“表决票、公司章程、增资协议、付款通知”等仍可作为 `documentType` 帮助理解文件和寻找证据，但它们不再是目录，也不再决定一个额外的子分类。

例如“佰特微立项表决结果.pdf”：

```text
documentType = voting_result      说明它是一份表决结果
businessStage = initiation        说明它发生在项目立项
folderId = project-initiation     最终直接归档到“项目立项”
archiveTitle = 佰特微立项表决结果 归档文件名
```

不会再先问“它是否命中投资决策 / 决策文件 / 表决票”，因此不会因为缺少“立项表决票”这个细分类而误入投资决策。

## 一、系统文件夹

系统固定提供八个可归档的业务阶段文件夹：

| 业务阶段 | `businessStage` | `folderId` | 显示路径 |
|---|---|---|---|
| 立项前 | `pre_initiation` | `pre-project` | 基金投资及投资执行 / 立项前 |
| 项目立项 | `initiation` | `project-initiation` | 基金投资及投资执行 / 项目立项 |
| 尽职调查 | `due_diligence` | `due-diligence` | 基金投资及投资执行 / 尽职调查 |
| 投资决策 | `investment_decision` | `investment-decision` | 基金投资及投资执行 / 投资决策 |
| 投资实施 | `investment_execution` | `investment-implementation` | 基金投资及投资执行 / 投资实施 |
| 投后管理 | `post_investment` | `post-investment` | 投后管理 |
| 退出决策 | `exit_decision` | `exit-decision` | 项目退出 / 退出决策 |
| 退出执行 | `exit_execution` | `exit-implementation` | 项目退出 / 退出执行 |

文件默认直接放在上述阶段文件夹中。系统不再预设“上会材料、决策文件、表决票、其他材料”等子目录。

用户主动创建的子文件夹属于人工组织方式：

- 自动分类仍只建议所属阶段根文件夹；
- 人工移动可以把文件放入自建子文件夹；
- `folderPath` 会保存实际路径；
- 自建子文件夹不会反过来扩充 LLM 的分类选项。

## 二、现在真正使用的字段

### 1. `businessStage`：业务判断

人能读懂的问题是：“这份文件发生在哪个阶段？”

它来自当前文件中的明确措辞、结构化事实、项目事件和关联文件。它不等于“项目当前进展”。补传历史文件时，文件自身证据优先，不能因为项目已经实施就把旧立项文件归入投资实施。

### 2. `folderId`：机器使用的目标文件夹 ID

这是最终归档位置的稳定标识，例如：

```text
businessStage = initiation
folderId = project-initiation
```

系统通过阶段到文件夹的一一映射产生它。前端确认和 API 提交只需要 `folderId`；服务端再从受控文件夹表解析正确的 `folderPath`，不相信客户端随意拼出的系统路径。

### 3. `folderPath`：实际存储路径

这是供展示、S3 路径和 ZIP 下载使用的路径数组，例如：

```json
["投资项目档案", "基金投资及投资执行", "项目立项"]
```

系统阶段文件夹的路径由服务端根据 `folderId` 生成。人工自建子文件夹或移动文件时，路径可继续向后延伸。

### 4. `documentType`：文件是什么

例如：

```text
voting_result
company_charter
shareholder_resolution
payment_notice
```

它用于：

- 选择需要抽取哪些事实；
- 决定是否检索章程、决议、协议等关联文件；
- 应用证据与排除规则；
- 在界面解释文件性质。

它不用于创建目录，也不能单独决定 `folderId`。同一种文件类型可以出现在不同阶段。

### 5. `archiveTitle`：文件归档后叫什么

它只负责文件名，不参与位置判断。

当前自动重命名规则：

1. 用户确认了 `archiveTitle`：清理非法字符，保留原扩展名；
2. 用户没有确认标题：保留原始文件名；
3. 同一文件夹重名：自动追加序号；
4. 标题不会再默认取“表决票、公司章程”等细分类名。

因此“分类位置”和“文件名称”是两件独立的事。

## 三、决策和调用流程

```text
读取文件
  ↓
抽取 documentType 和事实
  ↓
根据文件自身证据、项目 Context、关联文件判断 businessStage
  ↓
businessStage 明确？
  ├─ 是 → 一一映射为 folderId → 给出阶段文件夹建议
  └─ 否 → 不猜目录 → 人工选择八个阶段之一
  ↓
用户确认 folderId 和 archiveTitle
  ↓
服务端解析 folderPath
  ↓
写入 S3 和归档索引
```

关键安全规则：

1. 文档类型只提供证据，不是目录。
2. 阶段一旦明确，归档位置就是该阶段文件夹。
3. 不存在“阶段内缺少细分类”的情况，因为阶段文件夹本身就是完整目标。
4. 阶段冲突、事实抽取质量低或证据存在反例时转人工。
5. “投资合规性审查表”等风险样本可以继续要求复核，但复核者只确认阶段文件夹，不选择细分类。
6. Agent 主模式仍由人工确认后归档，不会自行写入档案。

Context 综合具有可恢复降级：如果大模型超时、返回空文本、没有完整 JSON 或返回内容不符合 Schema，系统会用当前有效文件事实生成确定性规则 Context，将具体原因写入 `synthesisWarnings`，但不会把更新标记为失败。文件日期不明确时使用 `date=null`。只有规则 Context 本身也无法生成时，才属于真正的 Context 更新失败。

## 四、API 现在传什么

分类响应的核心字段：

```json
{
  "targetFolder": {
    "folderId": "project-initiation",
    "name": "项目立项",
    "folderPath": ["投资项目档案", "基金投资及投资执行", "项目立项"],
    "businessStage": "initiation",
    "isSystemFolder": true
  },
  "businessStage": "initiation",
  "documentType": "voting_result",
  "confidence": 95,
  "reasoning": "文件明确为项目立项表决结果"
}
```

人工确认归档请求：

```json
{
  "projectId": "项目ID",
  "folderId": "project-initiation",
  "archiveTitle": "佰特微立项表决结果"
}
```

系统文件夹确认不再传 `categoryId`、`categoryName`，也不需要客户端提交 `folderPath`。

## 五、旧字段与本次变化

### 已从业务模型、API 和界面移除

| 旧字段或概念 | 以前做什么 | 为什么删除 |
|---|---|---|
| `FlatFileCategory` | 把“文件类型 + 文件夹”绑成一个类别 | 文件类型和位置不应绑定 |
| `FLAT_FILE_CATEGORIES` / `ARCHIVE_CLASSIFICATION_TARGETS` | 向关键词和 LLM 提供 50+ 叶子选项 | 选项过多且容易跨阶段误判 |
| `categoryId` | 兼作细分类 ID/文件夹 ID | 含义混乱，统一为 `folderId` |
| `categoryName` | 显示“表决票、公司章程、其他材料”等叶子名 | 实际归档不需要这层 |
| `selectedCategory` | Agent 的叶子类别结论 | 改为 `selectedFolder` |
| `candidateCategories` | 细分类候选列表 | 改为 `candidateFolders` |
| `isStageFallback` | 标记“其他阶段材料”安全兜底 | 阶段根目录就是正常目标，不存在兜底 |
| `safe_stage_fallback` | 表示没有叶子类型时降级 | 缺口已从模型上消失 |
| 关键词叶子分类分数 | 在 50+ 类型中竞争 | 不再决定目录 |
| LLM 类别索引 | 让模型从叶子列表选编号 | 不再需要 |
| `category-policies.ts` | 把证据规则绑定到叶子类别 | 证据判断现由文档事实与阶段决策器承担 |

### 保留并继续使用

| 字段 | 是否必需 | 用途 |
|---|---:|---|
| `folderId` | 是 | 最终目标文件夹稳定 ID |
| `folderPath` | 是 | 实际路径、展示、S3、ZIP |
| `businessStage` | 是 | 阶段判断与解释 |
| `documentType` | 是 | 事实抽取、关联检索、证据规则 |
| `archiveTitle` | 可选 | 人工确认后的归档名称 |
| `confidence` | 是 | 展示判断强度 |
| `reasoning` | 是 | 解释阶段依据 |
| `requiresHumanReview` | 是 | 冲突、低质量或特殊风险时转人工 |
| `selectedFolder` | 可空 | Agent 最终建议；阶段不明时为空 |
| `candidateFolders` | 可空 | 决策审计中的文件夹候选 |

### 当前数据库中暂时仍能看到的旧列名

当前 Coze 托管 Supabase 结构按项目约束不能在开发阶段迁移，因此物理表仍有：

```text
archived_files.category_id
archived_files.category_name
classification_decisions.selected_category_id
classification_decisions.selected_category_name
classification_decisions.candidate_categories
classification_decisions.corrected_category_id
classification_decisions.corrected_category_name
```

这些列名现在只存在于存储适配器内部：

- `category_id` 临时承载 `folderId`；
- `category_name` 临时承载路径最后一级名称；
- `selected_category_*` 临时承载 `selectedFolder*`；
- `candidate_categories` 临时承载 `candidateFolders`。
- `corrected_category_*` 是尚未启用的旧人工纠错预留列；未来迁移时应改为 `corrected_folder_*`，或在确认不需要决策审计后删除。

它们不再出现在页面、分类响应、归档请求和 TypeScript 业务接口中，也不参与分类。迁移到自有 Supabase 时可以直接重建测试数据并把物理列正式改为 folder 命名。

## 六、核心代码位置

- `src/lib/folder-structure.ts`：八个系统阶段文件夹及阶段到文件夹的一一映射。
- `src/lib/classification/business-stage.ts`：阶段证据判断。
- `src/lib/classification/context-decision.ts`：项目 Context、关联证据、冲突和复核策略。
- `src/lib/classification/classification-agent.ts`：LangGraph 证据检索流程。
- `src/app/api/classify/route.ts`：文件读取、事实抽取、阶段决策和响应。
- `src/app/api/archive/route.ts`：根据 `folderId` 服务端解析系统路径并归档。
- `src/lib/storage.ts`：S3、Supabase 和旧物理列兼容边界。

## 七、边界

- 当前 Agent 项目记忆继续使用 Coze S3 shadow mode。
- 开发阶段不启用 `PERSIST_PROJECT_MEMORY_SHADOW`，不修改托管 Supabase 结构。
- Agent 主模式仍要求人工确认；本次改动减少的是归档选项和字段，不是取消风险控制。
- 用户自建空文件夹目前没有独立文件夹表；自建路径随其中的归档文件存在。若未来需要保存空文件夹，再单独增加 `archive_folders` 表，不要恢复文档类型细分类。
