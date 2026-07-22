# 文件分类逻辑说明

## 分类策略

系统采用**两阶段分类策略**：

### 第一阶段：关键词快速匹配

根据文件名和内容中的关键词进行快速匹配。

#### 匹配规则

```typescript
function matchByKeywords(fileName: string, contentText: string) {
  const results = [];
  const lowerFileName = fileName.toLowerCase();
  const lowerContent = contentText.toLowerCase();

  for (const category of FLAT_FILE_CATEGORIES) {
    let score = 0;
    
    // 文件名匹配关键词（权重 +3）
    for (const keyword of category.keywords) {
      if (lowerFileName.includes(keyword.toLowerCase())) {
        score += 3;
      }
      // 内容匹配关键词（权重 +1）
      if (lowerContent.includes(keyword.toLowerCase())) {
        score += 1;
      }
    }
    
    if (score > 0) {
      results.push({ category, score });
    }
  }

  // 按分数降序排序
  return results.sort((a, b) => b.score - a.score);
}
```

#### 权重说明

| 匹配类型 | 权重 | 说明 |
|---------|------|------|
| 文件名匹配 | +3 | 文件名包含关键词 |
| 内容匹配 | +1 | 文件内容包含关键词 |

#### 置信度阈值

- **得分 ≥ 5**：高置信度，直接返回匹配结果
- **得分 < 5**：低置信度，进入第二阶段 AI 分析

### 第二阶段：AI 智能分析

当关键词匹配置信度不足时，调用 LLM 进行内容分析。

#### Prompt 设计

```typescript
const systemPrompt = `你是一个专业的投资项目档案分类助手。你的任务是根据文件名和文件内容，判断该文件应该归类到哪个文件夹中。

以下是可选的归档位置：
${categoryOptions}

请根据以下规则进行判断：
1. 首先检查文件名是否包含特定关键词
2. 然后分析文件内容，判断文件类型和主题
3. 选择最匹配的归档位置
4. 给出置信度（0-100）和判断理由

你必须以JSON格式回复，格式如下：
{
  "categoryIndex": 数字（对应上面的编号）,
  "confidence": 数字（0-100）,
  "reasoning": "判断理由"
}`;

const userMessage = `请分析以下文件并判断其归档位置：

文件名：${fileName}

文件内容摘要（前2000字）：
${contentText.slice(0, 2000)}

请以JSON格式回复你的判断结果。`;
```

#### LLM 配置

```typescript
const response = await client.invoke(messages, {
  model: 'doubao-seed-2-0-lite-260215',  // 或其他支持的模型
  temperature: 0.3,  // 低温度，确保分类稳定性
});
```

#### 响应解析

```typescript
// 解析 JSON 响应
const jsonMatch = response.content.match(/\{[\s\S]*\}/);
if (jsonMatch) {
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    categoryName: FLAT_FILE_CATEGORIES[parsed.categoryIndex - 1]?.fileName || '',
    confidence: parsed.confidence || 50,
    reasoning: parsed.reasoning || 'AI分析判断'
  };
}
```

## 文件内容提取

### 支持的格式

| 格式 | 提取方式 |
|------|---------|
| TXT/MD/CSV/JSON/XML | 直接 UTF-8 解码 |
| PDF/Word/Excel/PPT | 使用 FetchClient 解析 |

### 提取代码示例

```typescript
// 纯文本文件
if (['txt', 'md', 'csv', 'json', 'xml'].includes(extension)) {
  contentText = new TextDecoder('utf-8').decode(uint8Array);
} else {
  // 二进制文档使用 FetchClient
  const mimeType = getMimeType(extension);
  const base64 = Buffer.from(uint8Array).toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const fetchClient = new FetchClient(config, customHeaders);
  const fetchResponse = await fetchClient.fetch(dataUrl);
  
  const textItems = fetchResponse.content.filter(item => item.type === 'text');
  contentText = textItems.map(item => item.text || '').join('\n');
}
```

### MIME 类型映射

```typescript
function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'json': 'application/json',
    'xml': 'application/xml'
  };
  return mimeTypes[extension] || 'application/octet-stream';
}
```

## 分类结果格式

```typescript
interface ClassifyResult {
  fileName: string;        // 文件名
  fileSize: number;        // 文件大小（字节）
  category: {              // 分类结果
    folderPath: string[];  // 完整文件夹路径
    folderId: string;      // 文件夹 ID
    fileName: string;      // 文件类型名称
    keywords: string[];    // 匹配的关键词
    description?: string;  // 文件描述
  } | null;
  confidence: number;      // 置信度（0-100）
  reasoning: string;       // 判断理由
  contentPreview?: string; // 文件内容预览
}
```

## 置信度计算

```typescript
// 关键词匹配置信度
const confidence = Math.min(score * 10, 95); // 最高 95%

// AI 分析置信度
// 由 LLM 直接返回（0-100）
```

## 错误处理

1. **文件解析失败**：至少使用文件名进行分类
2. **LLM 调用失败**：降级到关键词匹配结果
3. **无法分类**：返回 `category: null`，提示用户手动分类
