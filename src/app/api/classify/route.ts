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
      suggestedArchiveTitle: string;
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
  suggestedArchiveTitle?: string;
  requiresArchiveConfirmation?: boolean;
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
  projectName: string,
  customHeaders: Record<string, string>,
  imageDataUrl?: string
): Promise<{
  categoryName: string;
  confidence: number;
  reasoning: string;
  suggestedArchiveTitle: string;
}> {
  const config = new Config();
  const client = new LLMClient(config, customHeaders);

  const categoryOptions = FLAT_FILE_CATEGORIES.map((cat, index) =>
    `${index + 1}. ${cat.folderPath.join('/')} / ${cat.fileName} (关键词: ${cat.keywords.join(', ')})`
  ).join('\n');

  const systemPrompt = `你是一个专业的投资项目档案分类与命名助手。

你的任务包括：
1. 根据文件名、文件文字内容以及可能提供的图片，判断文件所属的档案分类
2. 为文件生成一个准确、清晰、方便检索的建议档案标题

以下是可选的归档位置：
${categoryOptions}

请严格从以上分类中选择，不得自行创造新的分类。

【分类规则】
1. 综合判断文件名、正文主题、文件结构和可见图片内容
2. 文件名只能作为线索，不能在文件内容与文件名冲突时盲目采用文件名
3. 如果提供图片，需要分析图片中的场景、主体、物体、印章、证件和可见文字
4. 选择语义最匹配的归档位置
5. 无法充分判断时降低置信度，不得编造内容

【建议档案标题规则】
建议标题应当比分类名称更具体，但保持简洁，优先提取：
1. 文件涉及的主体名称，例如目标公司、被投企业、交易对方、基金或项目主体
2. 文件对应的业务期间，例如“2025年度”“2026年上半年”“2024-2026年”
3. 文件的具体事项，例如“A轮增资”“苏州工厂实地调研”“重大风险事件”
4. 文件类型，例如“财务尽调报告”“增资协议”“投委会决议”“投后管理报告”
5. 文件中明确出现的版本或状态，例如“签署版”“最终版”“修订版”

推荐标题结构：
主体名称 + 业务期间或关键事项 + 文件类型 + 明确的版本信息

标题示例：
星云科技-2025年度财务尽调报告
远航医疗-A轮增资协议-签署版
华辰新能源-2026年上半年投后管理报告
星云科技-苏州工厂实地调研照片
远航医疗-重大风险事件处置方案

生成标题时必须遵守：
1. 标题只能使用文件中真实存在的信息，不得猜测公司名称、年份、轮次、地点或版本
2. 公司全称过长时，可以使用文件中明确出现的标准简称
3. 如果主体名称与当前项目名称“${projectName || '未提供'}”高度重复，可以不在建议标题中重复，因为系统会在最终文件名中自动添加项目名称
4. 如果文件涉及的主体与当前项目名称不同，应当保留该主体名称
5. 业务年份指文件内容对应的年份，不是上传时间或归档时间
6. 不包含系统归档日期和文件扩展名
7. 不使用 / \\ : * ? " < > | 等非法字符
8. 不机械复制“扫描件”“新建文档”“最终最终版”等无意义内容
9. 建议控制在15至40个字符，最长不得超过50个字符
10. 无法提取更具体信息时，使用所选分类名称

【输出要求】
只输出一个合法JSON对象，不要使用Markdown代码块，不要添加任何额外说明。

格式必须为：
{
  "categoryIndex": 对应归档位置的数字编号,
  "confidence": 0到100之间的数字,
  "reasoning": "说明分类依据，包括文件名、正文或图片中的关键信息",
  "suggestedArchiveTitle": "建议档案标题"
}`;

  const userPrompt = `请分析以下文件，选择归档分类并生成建议档案标题。

当前项目名称：
${projectName || '未提供'}

原始文件名：
${fileName}

提取到的文件内容（前2000字）：
${contentText.slice(0, 2000)}

${imageDataUrl
    ? '已附上原始图片。请结合图片中的场景、主体、物体、印章、证件和可见文字进行判断，并在理由中说明视觉依据。'
    : '本次没有提供图片，请根据文件名和提取到的文字判断。'}

请严格按照系统要求，只返回JSON对象。`;

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
        reasoning: parsed.reasoning || 'AI分析判断',
        suggestedArchiveTitle:
          typeof parsed.suggestedArchiveTitle === 'string'
            ? parsed.suggestedArchiveTitle.trim()
            : ''
      };
    }
  } catch (error) {
    console.error('LLM classification error:', error);
  }

  return {
    categoryName: '',
    confidence: 0,
    reasoning: 'AI分类失败',
    suggestedArchiveTitle: ''
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
    const project = projectId ? await getProject(projectId) : null;

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
        project?.name || '',
        customHeaders,
        imageDataUrl
      );

      process.step2_llmAnalysis.result = llmResult;

      if (llmResult.categoryName && llmResult.confidence > 30) {
        const matchedCategory = FLAT_FILE_CATEGORIES.find(
          cat => cat.fileName === llmResult.categoryName ||
            cat.keywords.some(kw => llmResult.categoryName.includes(kw))
        );
        const finalCategory = matchedCategory || keywordMatches[0]?.category || null;

        process.finalDecision = {
          method: 'llm',
          explanation: `AI 分析置信度 ${llmResult.confidence}%，选择「${llmResult.categoryName}」作为归档位置；请确认或修改建议名称后归档`
        };

        result = {
          fileName,
          fileSize,
          category: finalCategory,
          confidence: llmResult.confidence,
          reasoning: llmResult.reasoning,
          contentPreview,
          process,
          suggestedArchiveTitle:
            llmResult.suggestedArchiveTitle || finalCategory?.fileName || '',
          requiresArchiveConfirmation: Boolean(finalCategory)
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
          process,
          suggestedArchiveTitle: keywordMatches[0].category.fileName,
          requiresArchiveConfirmation: true
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
    if (
      autoArchive &&
      projectId &&
      result.category &&
      !result.requiresArchiveConfirmation
    ) {
      try {
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
