import {
  Config,
  LLMClient,
  type Message,
} from 'coze-coding-dev-sdk';

import {
  createFallbackDocumentFacts,
  parseDocumentFactsResponse,
  type DocumentFactsExtractionResult,
} from './document-facts';

const DOCUMENT_FACTS_CONTENT_LIMIT = 8_000;
export const DOCUMENT_FACTS_MODEL = 'doubao-seed-2-0-lite-260215';
export const DOCUMENT_FACTS_EXTRACTOR_VERSION = 'document-facts-v1';

interface InvokeClient {
  invoke: LLMClient['invoke'];
}

export interface ExtractDocumentFactsParams {
  fileName: string;
  contentText: string;
  projectName: string;
  customHeaders: Record<string, string>;
  imageDataUrl?: string;
  client?: InvokeClient;
}

export function buildDocumentFactsPrompt(params: {
  fileName: string;
  contentText: string;
  projectName: string;
  imageDataUrl?: string;
}): Message[] {
  const systemPrompt = `你是严谨的投资项目档案事实抽取器。

你的唯一任务是从当前文件中提取可以核实的客观事实。不要选择归档目录，不要判断最终投资阶段，不要根据常识补全缺失信息。

【documentType 可选值】
company_charter, capital_increase_agreement, shareholder_agreement,
shareholder_resolution, board_resolution, investment_committee_resolution,
payment_notice, closing_confirmation, bank_receipt, due_diligence_report,
business_plan, project_initiation_report, project_initiation_application,
meeting_minutes, voting_result, investment_recommendation,
investment_compliance_review, business_license, financial_statement,
credit_report, confidentiality_agreement, capital_contribution_certificate,
shareholder_register, other, unknown

【抽取要求】
1. 日期统一输出 YYYY-MM-DD；只有年份或月份时不要猜测日期，date 使用 null，并在 meaning 和 evidence 中记录原文。
2. 主体名称尽量保留文件中的完整名称，并说明其在文件中的角色。
3. 注册资本、投资金额、股东、持股比例等前后变化写入 transactionChanges。
4. 签字和盖章只根据可见信息判断；无法判断时使用 unknown。
5. evidenceQuotes 只能包含当前输入中真实出现的短句或关键数据。
6. 如果内容来自扫描 PDF 视觉摘要，应将 sourceQuality 设为 visual_summary 或 mixed，并在 warnings 中说明信息可能不完整。
7. extractionConfidence 表示事实抽取完整度，不表示归档分类置信度。

只输出一个 JSON 对象，不要输出 Markdown 或其他说明。JSON 必须严格符合：
{
  "schemaVersion": 1,
  "documentType": "上述枚举值",
  "rawDocumentType": "文件中的中文类型名称，无法判断填未知",
  "title": "文件正式标题，无法识别时使用原文件名主体",
  "documentNumber": "编号或null",
  "version": "版本或null",
  "dates": [{"date":"YYYY-MM-DD或null","meaning":"日期含义","evidence":"原文证据"}],
  "parties": [{"name":"主体全称","role":"主体角色"}],
  "signStatus": "unsigned|signed|sealed|signed_and_sealed|unknown",
  "transactionChanges": [{"field":"变化字段","before":"变化前或null","after":"变化后或null","evidence":"证据"}],
  "explicitStageClues": ["文件中明确出现的业务动作，不是最终分类"],
  "evidenceQuotes": ["可核实的短句或关键数据"],
  "warnings": ["缺失信息或识别风险"],
  "sourceQuality": "text|visual_summary|image|filename_only|mixed",
  "extractionConfidence": 0到100之间的整数
}`;

  const userPrompt = `当前项目名称（仅用于识别相关主体，不得用于推断阶段）：
${params.projectName || '未提供'}

原始文件名：
${params.fileName}

提取到的文件内容：
${params.contentText.slice(0, DOCUMENT_FACTS_CONTENT_LIMIT) || '[没有提取到文字]'}

${params.imageDataUrl
    ? '同时附有原始图片。请结合可见文字、签名和印章提取事实。'
    : '没有附加原始图片，只能使用文件名和上述文字。'}`;

  const userContent: Message['content'] = params.imageDataUrl
    ? [
        { type: 'text', text: userPrompt },
        {
          type: 'image_url',
          image_url: { url: params.imageDataUrl, detail: 'high' },
        },
      ]
    : userPrompt;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

export async function extractDocumentFacts(
  params: ExtractDocumentFactsParams
): Promise<DocumentFactsExtractionResult> {
  const client =
    params.client ??
    new LLMClient(new Config(), params.customHeaders);
  const messages = buildDocumentFactsPrompt({
    fileName: params.fileName,
    contentText: params.contentText,
    projectName: params.projectName,
    imageDataUrl: params.imageDataUrl,
  });

  try {
    const response = await client.invoke(messages, {
      model: DOCUMENT_FACTS_MODEL,
      temperature: 0.1,
    });
    return {
      status: 'success',
      facts: parseDocumentFactsResponse(response.content),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Document facts extraction error:', error);
    return {
      status: 'fallback',
      facts: createFallbackDocumentFacts(
        params.fileName,
        `结构化事实抽取失败：${message}`
      ),
      error: message,
    };
  }
}
