# 投资项目档案管理系统

## 项目概览
基于 Next.js 16 的智能投资项目档案管理系统，支持文件上传、自动分类和归档建议。遵循《国创致远-投资项目档案管理》文档规范。

## 技术栈
- **框架**: Next.js 16 (App Router)
- **语言**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **样式**: Tailwind CSS 4
- **AI 能力**: coze-coding-dev-sdk (LLM + FetchClient)

## 文件结构
```
src/
├── app/
│   ├── api/classify/route.ts  # 文件分类 API
│   ├── layout.tsx              # 根布局
│   └── page.tsx                # 主页面
├── components/ui/              # shadcn/ui 组件库
├── lib/
│   ├── folder-structure.ts     # 文件夹结构定义
│   └── utils.ts                # 工具函数
└── hooks/                      # React Hooks
```

## 核心模块说明

### folder-structure.ts
- **FOLDER_STRUCTURE**: 完整的档案管理文件夹树形结构
- **FLAT_FILE_CATEGORIES**: 扁平化的文件分类列表，便于搜索匹配
- **FolderNode**: 文件夹节点接口
- **FileTemplate**: 文件模板接口（含关键词）

### api/classify/route.ts
- **POST**: 处理文件上传和智能分类
- **matchByKeywords()**: 关键词快速匹配函数
- **classifyWithLLM()**: 使用 LLM 进行智能分类
- 支持 PDF、Word、Excel、PPT、TXT 等格式

## 文件分类逻辑
1. **关键词匹配**: 先进行快速关键词匹配（文件名 + 内容）
2. **LLM 分析**: 如果关键词匹配置信度低，调用 LLM 进行智能分析
3. **结果返回**: 返回分类建议、置信度和判断理由

## 文件夹结构（三级分类）
```
投资项目档案/
├── 基金投资及投资执行/
│   ├── 立项前/
│   ├── 项目立项/
│   ├── 尽职调查/
│   ├── 投资决策/
│   │   ├── 上会材料/
│   │   └── 决策文件/
│   └── 投资实施/
├── 投后管理/
│   ├── 投后管理报告/
│   ├── 实地调研/
│   ├── 更新被投企业材料/
│   └── 投后风险管理/
└── 项目退出/
    ├── 退出决策/
    │   ├── 上会材料/
    │   └── 决策文件/
    └── 退出执行/
```

## API 接口

### POST /api/classify
上传文件进行智能分类。

**请求**: `multipart/form-data`
- `file`: 文件（PDF/Word/Excel/PPT/TXT）

**响应**:
```json
{
  "fileName": "string",
  "fileSize": number,
  "category": {
    "folderPath": ["string"],
    "folderId": "string",
    "fileName": "string",
    "keywords": ["string"],
    "description": "string"
  },
  "confidence": number,
  "reasoning": "string",
  "contentPreview": "string"
}
```

## 运行命令
- `pnpm dev`: 启动开发环境
- `pnpm build`: 构建生产版本
- `pnpm start`: 启动生产环境
- `pnpm lint`: 代码检查
- `pnpm ts-check`: TypeScript 类型检查

## 环境变量
- `DEPLOY_RUN_PORT`: 服务监听端口（默认 5000）
- `COZE_PROJECT_DOMAIN_DEFAULT`: 对外访问域名

## 依赖说明
- `coze-coding-dev-sdk`: 提供 LLM 和文件解析能力
  - `LLMClient`: 大语言模型调用
  - `FetchClient`: 文件内容提取
  - `HeaderUtils`: 请求头提取