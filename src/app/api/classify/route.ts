import { NextRequest, NextResponse } from 'next/server';
import {
  LLMClient,
  FetchClient,
  Config,
  HeaderUtils,
  type Message,
} from 'coze-coding-dev-sdk';
import { FLAT_FILE_CATEGORIES, type FlatFileCategory } from '@/lib/folder-structure';
import { archiveFile, getProject } from '@/lib/storage';

export const runtime = 'nodejs';

// 关键词匹配详情
interface KeywordMatchDetail {
  categoryName: string;
  folderPath: string[];
  score: number;
  matchedKeywords: string[];
  fileNameMatches: string[];
  contentMatches: string[];
}

// 分类过程详情
interface ClassifyProcess {
  step1_keywordMatch: {
    totalCategories: number;
    matchedCategories: number;
    details: KeywordMatchDetail[];
    bestMatch?: KeywordMatchDetail;
    threshold: number;
    passed: boolean;
  };
  step2_llmAnalysis?: {
    triggered: boolean;
    reason: string;
    result?: {
      categoryName: string;
      confidence: number;
      reasoning: string;
    };
  };
  finalDecision: {
    method: 'keyword' | 'llm' | 'fallback' | 'none';
    explanation: string;
  };
}

// 文件分类结果接口
interface ClassifyResult {
  fileName: string;
  fileSize: number;
  category: FlatFileCategory | null;
  confidence: number;
  reasoning: string;
  contentPreview?: string;
  process: ClassifyProcess;
  archived?: {
    id: string;
    archivedName: string;
    projectName: string;
    folderPath: string[];
  };
}

// 关键词匹配函数
function matchByKeywords(fileName: string, contentText: string): {
  category: FlatFileCategory;
  score: number;
  matchedKeywords: string[];
  fileNameMatches: string[];
  contentMatches: string[];
}[] {
  const results: {
    category: FlatFileCategory;
    score: number;
    matchedKeywords: string[];
    fileNameMatches: string[];
    contentMatches: string[];
  }[] = [];
  const lowerFileName = fileName.toLowerCase();
  const lowerContent = contentText.toLowerCase();

  for (const category of FLAT_FILE_CATEGORIES) {
    let score = 0;
    const matchedKeywords: string[] = [];
    const fileNameMatches: string[] = [];
    const contentMatches: string[] = [];

    for (const keyword of category.keywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (lowerFileName.includes(lowerKeyword)) {
        score += 3;
        matchedKeywords.push(keyword);
        fileNameMatches.push(keyword);
      }
      if (lowerContent.includes(lowerKeyword)) {
        score += 1;
        if (!matchedKeywords.includes(keyword)) {
          matchedKeywords.push(keyword);
        }
        contentMatches.push(keyword);
      }
    }

    if (score > 0) {
      results.push({ category, score, matchedKeywords, fileNameMatches, contentMatches });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// 使用 LLM 进行智能分类
async function classifyWithLLM(
  fileName: string,
  contentText: string,
  customHeaders: Record<string, string>,
  imageDataUrl?: string
): Promise<{ categoryName: string; confidence: number; reasoning: string }> {
  const config = new Config();
  const client = new LLMClient(config, customHeaders);

  const categoryOptions = FLAT_FILE_CATEGORIES.map((cat, index) =>
    `${index + 1}. ${cat.folderPath.join('/')} / ${cat.fileName} (关键词: ${cat.keywords.join(', ')})`
  ).join('\n');

  const systemPrompt = `你是一个专业的投资项目档案分类助手。你的任务是根据文件名和文件内容，判断该文件应该归类到哪个文件夹中。

以下是可选的归档位置：
${categoryOptions}

请根据以下规则进行判断：
1. 首先检查文件名是否包含特定关键词
2. 然后分析文件文字内容，判断文件类型和主题
3. 如果提供了图片，必须分析图片中的场景、物体和可见文字，不能只根据文件名判断
4. 选择最匹配的归档位置
5. 给出置信度（0-100）和判断理由；图片分类理由应说明观察到的视觉依据

你必须以JSON格式回复，格式如下：
{
  "categoryIndex": 数字（对应上面的编号）,
  "confidence": 数字（0-100）,
  "reasoning": "判断理由"
}`;

  const userPrompt = `请分析以下文件并判断其归档位置：

文件名：${fileName}

文件内容摘要（前2000字）：
${contentText.slice(0, 2000)}

${imageDataUrl ? '已附上原始图片。请结合画面内容、可见文字和文件名进行分类，并在理由中说明你从图片中观察到的依据。' : ''}

请以JSON格式回复你的判断结果。`;

  const userContent: Message['content'] = imageDataUrl
    ? [
        { type: 'text', text: userPrompt },
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
            detail: 'high',
          },
        },
      ]
    : userPrompt;

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: userContent,
    }
  ];

  try {
    const response = await client.invoke(messages, {
      model: 'doubao-seed-2-0-lite-260215',
      temperature: 0.3,
    });

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
    const projectId = formData.get('projectId') as string;
    const autoArchive = formData.get('autoArchive') !== 'false'; // 默认自动归档

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

    let contentText = '';
    let contentPreview = '';
    let imageDataUrl: string | undefined;

    try {
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      const extension = fileName.split('.').pop()?.toLowerCase() || '';

      if (['txt', 'md', 'csv', 'json', 'xml'].includes(extension)) {
        contentText = new TextDecoder('utf-8').decode(uint8Array);
      } else if (isImageFile(extension)) {
        // 图片文件：保留原图 Data URL，稍后交给多模态 LLM 分析视觉内容
        const mimeType = getMimeType(extension);
        const base64 = Buffer.from(uint8Array).toString('base64');
        imageDataUrl = `data:${mimeType};base64,${base64}`;
        contentText = `[图片文件] 格式: ${extension.toUpperCase()}, 文件名: ${fileName}。请结合原始图片的场景、物体和可见文字进行分类。`;
      } else {
        const mimeType = getMimeType(extension);
        const base64 = Buffer.from(uint8Array).toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;

        const fetchConfig = new Config();
        const fetchClient = new FetchClient(fetchConfig, customHeaders);

        try {
          const fetchResponse = await fetchClient.fetch(dataUrl);
          const textItems = fetchResponse.content.filter(item => item.type === 'text');
          contentText = textItems.map(item => item.text || '').join('\n');
        } catch (fetchError) {
          console.error('FetchClient error:', fetchError);
          contentText = fileName;
        }
      }

      contentPreview = contentText.slice(0, 500) + (contentText.length > 500 ? '...' : '');

    } catch (readError) {
      console.error('File read error:', readError);
      contentText = fileName;
    }

    // 第一步：关键词快速匹配
    const keywordMatches = matchByKeywords(fileName, contentText);

    const keywordMatchDetails: KeywordMatchDetail[] = keywordMatches.slice(0, 5).map(m => ({
      categoryName: m.category.fileName,
      folderPath: m.category.folderPath,
      score: m.score,
      matchedKeywords: m.matchedKeywords,
      fileNameMatches: m.fileNameMatches,
      contentMatches: m.contentMatches
    }));

    const process: ClassifyProcess = {
      step1_keywordMatch: {
        totalCategories: FLAT_FILE_CATEGORIES.length,
        matchedCategories: keywordMatches.length,
        details: keywordMatchDetails,
        bestMatch: keywordMatchDetails[0],
        threshold: 5,
        passed: !imageDataUrl && keywordMatches.length > 0 && keywordMatches[0].score >= 5
      },
      finalDecision: {
        method: 'none',
        explanation: ''
      }
    };

    let result: ClassifyResult;

    // 如果关键词匹配置信度高，直接返回
    if (!imageDataUrl && keywordMatches.length > 0 && keywordMatches[0].score >= 5) {
      const bestMatch = keywordMatches[0];
      process.finalDecision = {
        method: 'keyword',
        explanation: `关键词匹配得分 ${bestMatch.score} 分，超过阈值 5 分，直接使用关键词匹配结果`
      };

      result = {
        fileName,
        fileSize,
        category: bestMatch.category,
        confidence: Math.min(bestMatch.score * 10, 95),
        reasoning: `文件名和内容匹配关键词："${bestMatch.matchedKeywords.join('、')}"，归类到「${bestMatch.category.fileName}」`,
        contentPreview,
        process
      };
    } else {
      // 第二步：使用 LLM 进行智能分析
      process.step2_llmAnalysis = {
        triggered: true,
        reason: imageDataUrl
          ? '检测到图片文件，需要 AI 分析画面内容和可见文字'
          : `关键词匹配得分不足（最高 ${keywordMatches[0]?.score || 0} 分 < 阈值 5 分），需要 AI 智能分析`
      };

      const llmResult = await classifyWithLLM(
        fileName,
        contentText,
        customHeaders,
        imageDataUrl
      );

      process.step2_llmAnalysis.result = llmResult;

      if (llmResult.categoryName && llmResult.confidence > 30) {
        const matchedCategory = FLAT_FILE_CATEGORIES.find(
          cat => cat.fileName === llmResult.categoryName ||
            cat.keywords.some(kw => llmResult.categoryName.includes(kw))
        );

        process.finalDecision = {
          method: 'llm',
          explanation: `AI 分析置信度 ${llmResult.confidence}%，选择「${llmResult.categoryName}」作为归档位置`
        };

        result = {
          fileName,
          fileSize,
          category: matchedCategory || keywordMatches[0]?.category || null,
          confidence: llmResult.confidence,
          reasoning: llmResult.reasoning,
          contentPreview,
          process
        };
      } else if (keywordMatches.length > 0) {
        process.finalDecision = {
          method: 'fallback',
          explanation: `AI 分析置信度不足（${llmResult.confidence}%），降级使用关键词匹配的最佳结果`
        };

        result = {
          fileName,
          fileSize,
          category: keywordMatches[0].category,
          confidence: keywordMatches[0].score * 10,
          reasoning: `根据关键词匹配，归类到「${keywordMatches[0].category.fileName}」`,
          contentPreview,
          process
        };
      } else {
        process.finalDecision = {
          method: 'none',
          explanation: '关键词匹配和 AI 分析均无法确定分类，需要手动分类'
        };

        result = {
          fileName,
          fileSize,
          category: null,
          confidence: 0,
          reasoning: '无法确定文件归档位置，请手动分类。文件内容未匹配任何已知分类关键词。',
          contentPreview,
          process
        };
      }
    }

    // 自动归档
    if (autoArchive && projectId && result.category) {
      try {
        const project = await getProject(projectId);

        if (project) {
          const buffer = await file.arrayBuffer();
          const extension = fileName.split('.').pop()?.toLowerCase() || '';
          const mimeType = getMimeType(extension);

          const archived = await archiveFile({
            fileBuffer: Buffer.from(buffer),
            originalName: fileName,
            projectId,
            projectName: project.name,
            categoryId: result.category.folderId,
            categoryName: result.category.fileName,
            folderPath: result.category.folderPath,
            mimeType,
            confidence: result.confidence,
            reasoning: result.reasoning,
          });

          result.archived = {
            id: archived.id,
            archivedName: archived.archivedName,
            projectName: project.name,
            folderPath: archived.folderPath
          };
        }
      } catch (archiveError) {
        console.error('Archive error:', archiveError instanceof Error ? archiveError.message : String(archiveError));
        console.error('Archive error stack:', archiveError instanceof Error ? archiveError.stack : '');
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
    'xml': 'application/xml',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
  };

  return mimeTypes[extension] || 'application/octet-stream';
}

// 判断是否为图片格式
function isImageFile(extension: string): boolean {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(extension);
}
