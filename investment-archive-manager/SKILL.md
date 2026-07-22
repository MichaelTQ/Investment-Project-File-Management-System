---
name: investment-archive-manager
description: 投资项目档案管理系统开发技能。当用户需要创建投资项目档案管理系统、文件智能分类归档系统、基于文档规范的文件管理应用时使用。支持文件夹架构定义、文件上传、关键词匹配和 AI 智能分类。
---

# 投资项目档案管理系统开发技能

## 何时使用

- 用户需要开发投资项目档案管理系统
- 用户需要文件智能分类和归档功能
- 用户需要基于文档规范创建文件夹架构
- 用户提到"档案管理"、"文件分类"、"投资项目管理"等关键词

## 核心能力

1. **文件夹架构定义**：基于《国创致远-投资项目档案管理》文档的三级文件夹结构
2. **文件上传**：支持拖拽/点击上传，批量处理
3. **智能分类**：关键词匹配 + AI 智能分析双重分类策略
4. **结果展示**：分类结果、置信度、判断理由

## 操作步骤

### 第一步：创建文件夹架构定义

读取 `references/folder-structure.md` 获取完整的文件夹架构定义，创建 `src/lib/folder-structure.ts` 文件。

架构包含三大阶段：
- 基金投资及投资执行（立项前、项目立项、尽职调查、投资决策、投资实施）
- 投后管理（投后管理报告、实地调研、更新被投企业材料、投后风险管理）
- 项目退出（退出决策、退出执行）

### 第二步：实现文件分类 API

创建 `src/app/api/classify/route.ts`，实现文件分类逻辑：

1. **关键词匹配**：遍历预定义的文件类别，匹配文件名和内容中的关键词
2. **AI 智能分析**：当关键词匹配不确定时，调用 LLM 进行内容分析
3. **返回结果**：归档位置、置信度、判断理由

分类 API 接口：
```typescript
// POST /api/classify
// 请求：multipart/form-data
// - file: File

// 响应：
{
  fileName: string,
  fileSize: number,
  category: {
    folderPath: string[],
    folderId: string,
    fileName: string,
    keywords: string[],
    description: string
  },
  confidence: number,
  reasoning: string,
  contentPreview: string
}
```

### 第三步：实现前端界面

创建主页面，包含：
- 左侧：文件夹结构树形展示
- 右侧：文件上传区域 + 分类结果展示

参考 `assets/page-example.tsx` 获取界面实现示例。

### 第四步：集成 AI 能力

使用 `coze-coding-dev-sdk` 集成 LLM 和文件解析：
- `LLMClient`：用于智能分类分析
- `FetchClient`：用于解析上传的文件内容
- `HeaderUtils`：用于请求头提取

## 技术栈要求

- **框架**：Next.js 14+ (App Router)
- **语言**：TypeScript
- **UI 组件**：shadcn/ui + Tailwind CSS
- **AI 能力**：coze-coding-dev-sdk

## 资源索引

- `references/folder-structure.md`：完整的文件夹架构定义，包含所有文件类型和关键词
- `references/classify-logic.md`：文件分类逻辑详细说明
- `assets/page-example.tsx`：前端界面实现示例代码

## 注意事项

1. **文件内容提取**：对于二进制文档（PDF、Word、Excel、PPT），需要使用 FetchClient 解析
2. **关键词权重**：文件名匹配权重高于内容匹配（文件名 +3，内容 +1）
3. **置信度计算**：根据匹配分数计算置信度，最高 95%
4. **LLM 调用**：使用 `doubao-seed-2-0-lite-260215` 模型，temperature 设为 0.3
5. **TypeScript 类型**：确保消息类型正确定义，避免 TS2345 错误

## 常见错误

1. **端口冲突**：确保启动前清理占用端口的进程
2. **类型错误**：LLM 消息需要明确定义类型 `Array<{ role: 'system' | 'user' | 'assistant'; content: string }>`
3. **文件解析失败**：对于无法解析的文件，至少使用文件名进行分类
