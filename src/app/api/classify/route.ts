import { NextRequest, NextResponse } from 'next/server';
import { LLMClient, FetchClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { FLAT_FILE_CATEGORIES, type FlatFileCategory } from '@/lib/folder-structure';

export const runtime = 'nodejs';

// 文件分类结果接口
interface ClassifyResult {
  fileName: string;
  fileSize: number;
  category: FlatFileCategory | null;
  confidence: number;
  reasoning: string;
  contentPreview?: string;
}

// 关键词匹配函数 - 先进行快速关键词匹配
function matchByKeywords(fileName: string, contentText: string): { category: FlatFileCategory; score: number }[] {
  const results: { category: FlatFileCategory; score: number }[] = [];
  const lowerFileName = fileName.toLowerCase();
  const lowerContent = contentText.toLowerCase();

  for (const category of FLAT_FILE_CATEGORIES) {
    let score = 0;
    
    // 文件名匹配关键词
    for (const keyword of category.keywords) {
      if (lowerFileName.includes(keyword.toLowerCase())) {
        score += 3; // 文件名匹配权重更高
      }
      if (lowerContent.includes(keyword.toLowerCase())) {
        score += 1; // 内容匹配
      }
    }
    
    if (score > 0) {
      results.push({ category, score });
    }
  }

  // 按分数排序
  return results.sort((a, b) => b.score - a.score);
}

// 使用 LLM 进行智能分类
async function classifyWithLLM(
  fileName: string,
  contentText: string,
  customHeaders: Record<string, string>
): Promise<{ categoryName: string; confidence: number; reasoning: string }> {
  const config = new Config();
  const client = new LLMClient(config, customHeaders);

  // 构建文件类别列表供 LLM 选择
  const categoryOptions = FLAT_FILE_CATEGORIES.map((cat, index) => 
    `${index + 1}. ${cat.folderPath.join('/')} / ${cat.fileName} (关键词: ${cat.keywords.join(', ')})`
  ).join('\n');

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

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { 
      role: 'user', 
      content: `请分析以下文件并判断其归档位置：

文件名：${fileName}

文件内容摘要（前2000字）：
${contentText.slice(0, 2000)}

请以JSON格式回复你的判断结果。` 
    }
  ];

  try {
    const response = await client.invoke(messages, {
      model: 'doubao-seed-2-0-lite-260215',
      temperature: 0.3,
    });

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
  } catch (error) {
    console.error('LLM classification error:', error);
  }

  return {
    categoryName: '',
    confidence: 0,
    reasoning: 'AI分类失败'
  };
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { error: '未提供文件' },
        { status: 400 }
      );
    }

    const fileName = file.name;
    const fileSize = file.size;

    // 提取请求头
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);

    // 创建临时 URL 用于 FetchClient 解析
    // 由于 FetchClient 需要一个 URL，我们需要先将文件上传到临时位置
    // 这里我们使用另一种方式：直接读取文件内容

    let contentText = '';
    let contentPreview = '';

    try {
      // 读取文件内容
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      
      // 对于文本文件，直接解码
      // 对于二进制文件（如 PDF、Word），需要使用 FetchClient
      const extension = fileName.split('.').pop()?.toLowerCase();
      
      if (['txt', 'md', 'csv', 'json', 'xml'].includes(extension || '')) {
        // 纯文本文件直接解码
        contentText = new TextDecoder('utf-8').decode(uint8Array);
      } else {
        // 对于二进制文档，使用 FetchClient
        // 创建 Data URL
        const mimeType = getMimeType(extension || '');
        const base64 = Buffer.from(uint8Array).toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;

        const fetchConfig = new Config();
        const fetchClient = new FetchClient(fetchConfig, customHeaders);

        try {
          const fetchResponse = await fetchClient.fetch(dataUrl);
          
          // 提取文本内容
          const textItems = fetchResponse.content.filter(item => item.type === 'text');
          contentText = textItems.map(item => item.text || '').join('\n');
        } catch (fetchError) {
          console.error('FetchClient error:', fetchError);
          // 如果 FetchClient 失败，尝试使用文件名进行分类
          contentText = fileName;
        }
      }

      // 截取内容预览
      contentPreview = contentText.slice(0, 500) + (contentText.length > 500 ? '...' : '');

    } catch (readError) {
      console.error('File read error:', readError);
      contentText = fileName; // 至少使用文件名进行分类
    }

    // 第一步：关键词快速匹配
    const keywordMatches = matchByKeywords(fileName, contentText);

    let result: ClassifyResult;

    // 如果关键词匹配置信度高，直接返回
    if (keywordMatches.length > 0 && keywordMatches[0].score >= 5) {
      const bestMatch = keywordMatches[0];
      result = {
        fileName,
        fileSize,
        category: bestMatch.category,
        confidence: Math.min(bestMatch.score * 10, 95), // 最高 95%
        reasoning: `文件名和内容匹配关键词："${bestMatch.category.keywords.filter(kw => 
          fileName.toLowerCase().includes(kw.toLowerCase()) || 
          contentText.toLowerCase().includes(kw.toLowerCase())
        ).join('、')}"，归类到「${bestMatch.category.fileName}」`,
        contentPreview
      };
    } else {
      // 第二步：使用 LLM 进行智能分析
      const llmResult = await classifyWithLLM(fileName, contentText, customHeaders);

      if (llmResult.categoryName && llmResult.confidence > 30) {
        // 找到对应的分类
        const matchedCategory = FLAT_FILE_CATEGORIES.find(
          cat => cat.fileName === llmResult.categoryName || 
                 cat.keywords.some(kw => llmResult.categoryName.includes(kw))
        );

        result = {
          fileName,
          fileSize,
          category: matchedCategory || keywordMatches[0]?.category || null,
          confidence: llmResult.confidence,
          reasoning: llmResult.reasoning,
          contentPreview
        };
      } else if (keywordMatches.length > 0) {
        // 使用关键词匹配的最佳结果
        result = {
          fileName,
          fileSize,
          category: keywordMatches[0].category,
          confidence: keywordMatches[0].score * 10,
          reasoning: `根据关键词匹配，归类到「${keywordMatches[0].category.fileName}」`,
          contentPreview
        };
      } else {
        // 无法分类
        result = {
          fileName,
          fileSize,
          category: null,
          confidence: 0,
          reasoning: '无法确定文件归档位置，请手动分类。文件内容未匹配任何已知分类关键词。',
          contentPreview
        };
      }
    }

    return NextResponse.json(result);

  } catch (error) {
    console.error('Classification error:', error);
    return NextResponse.json(
      { 
        error: '文件处理失败',
        details: error instanceof Error ? error.message : '未知错误'
      },
      { status: 500 }
    );
  }
}

// 获取 MIME 类型
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