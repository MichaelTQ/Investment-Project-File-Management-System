import { FetchClient, Config, type ContentPart } from 'coze-coding-dev-sdk';

import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from './chat-completions';
import { extractLocalPdfText } from './local-pdf-text';
import { getStoredFileUrl, readStoredFile, uploadTempFileFromBuffer } from '../storage';

/**
 * 把一份文件读成模型能看的文本。
 *
 * 这段逻辑原先内联在 `/api/classify` 路由里（约 130 行）。抽出来是因为**深挖旁路要复用
 * 同一条读取链路**：深挖里最贵的那个工具就是"读一份文件的内容"，它必须和主链路读到
 * 完全一样的东西，否则同一份文件在两条路上会得出不同的事实，评测也就失去意义。
 *
 * 抽取时**只搬运，不改行为**：阶段名、回退顺序、超时、模型 ID、提示词全部照旧。
 *
 * 读取链路（按优先级回退）：
 *
 * ```
 * 纯文本类（txt/md/csv/json/xml）→ 直接按 UTF-8 解码
 * 图片类                        → 不读文本，产出签名 URL 交给视觉模型
 * PDF                          → 本地取文字层
 *                                  ↓ 文字层不足 30 字（扫描件）
 *                                Coze 解析服务
 *                                  ↓ 仍不足 30 字
 *                                逐页图片交多模态模型做 OCR
 * Office 等其他                  → 直接走 Coze 解析服务
 * ```
 *
 * 「30 字」这个阈值是判断"有没有文字层"的实际判据：扫描件经常带几个页眉页脚的字符，
 * 完全为空反而少见。
 */

/** 大文件阈值：超过此大小的 multipart 文件先上传 S3 临时目录，避免 Base64 膨胀导致 502 */
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

/**
 * 扫描件 OCR 的三个旋钮，都可以用环境变量调，方便直接 A/B 不用改代码。
 *
 * PDF_VISUAL_BATCH_SIZE：每次调用塞几页。**调小反而更快**——各批是并行的，
 * 总耗时取决于最慢的一批，一批 6 页当然比一批 3 页慢。调大省的是调用次数
 * （成本），不是等待时间。
 *
 * PDF_VISUAL_DETAIL：视觉精度。high 是每页上千视觉 token 的主要来源，扫描件
 * 小字靠它才读得准；low 能把 token 降一个量级，但可能读错数字。默认 high。
 *
 * PDF_VISUAL_MAX_PAGES：最多读几页，从第一页开始截。超出的页数完全不会被模型
 * 看到——20 页的文件现在只读前 12 页，后 8 页等于不存在。
 */
function envInt(name: string, fallback: number): number {
  const parsed = Number(globalThis.process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const PDF_VISUAL_BATCH_SIZE = envInt('PDF_VISUAL_BATCH_SIZE', 4);
const PDF_VISUAL_MAX_PAGES = envInt('PDF_VISUAL_MAX_PAGES', 12);
// 默认 high。曾经试过默认 low，但实测那份文件的解析服务直接返回了文字层，
// 视觉这条路根本没被触发，等于没测——而真扫描件才走这里，读错金额小数位的
// 代价远大于省下的几秒。要再试 low 就设 PDF_VISUAL_DETAIL=low，并确认阶段
// 耗时里出现了 ocr_scanned_pdf，否则测的不是这个开关。
const PDF_VISUAL_DETAIL: 'high' | 'low' =
  globalThis.process.env.PDF_VISUAL_DETAIL === 'low' ? 'low' : 'high';

// 启动时打印一次。环境变量是在模块加载时读的，服务不重启就不会生效——
// 没有这行日志，改没改成只能靠猜 OCR 质量，很容易测了半天其实一直是旧值。
console.log(
  `[OCR] detail=${PDF_VISUAL_DETAIL} batch=${PDF_VISUAL_BATCH_SIZE} maxPages=${PDF_VISUAL_MAX_PAGES}`
);

export function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  return mimeTypes[extension] || 'application/octet-stream';
}

export function isImageFile(extension: string): boolean {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(extension);
}

/**
 * 记录阶段耗时。调用方传自己的实现（分类路由要把耗时回给前端），不传就不计时。
 *
 * 阶段名保持与原有实现一致，前端的性能面板和现有排查经验都依赖这些名字。
 */
export type MeasurePhase = <T>(
  phase: string,
  action: () => Promise<T>,
  parentPhase?: string
) => Promise<T>;

const noMeasure: MeasurePhase = (_phase, action) => action();

// 扫描 PDF 没有文字层时，将解析服务返回的页面图片分批交给多模态模型提取关键信息。
async function extractScannedPdfText(
  pageImageUrls: string[],
  fileName: string,
  customHeaders: Record<string, string>
): Promise<{ text: string; modelCalls: ModelCallDiagnostics[] }> {
  const selectedUrls = pageImageUrls.slice(0, PDF_VISUAL_MAX_PAGES);
  if (selectedUrls.length === 0) return { text: '', modelCalls: [] };

  const batches: string[][] = [];
  for (let index = 0; index < selectedUrls.length; index += PDF_VISUAL_BATCH_SIZE) {
    batches.push(selectedUrls.slice(index, index + PDF_VISUAL_BATCH_SIZE));
  }

  const batchResults = await Promise.all(
    batches.map(async (batch, batchIndex) => {
      const firstPage = batchIndex * PDF_VISUAL_BATCH_SIZE + 1;
      const content: ContentPart[] = [
        {
          type: 'text',
          text: `你正在读取扫描版PDF《${fileName}》的第${firstPage}至${firstPage + batch.length - 1}页。
请只提取图片中能够明确辨认的关键信息，包括：
1. 文件正式标题和文件类型
2. 公司、基金、协议方等主体全称
3. 日期、编号、版本、签署或盖章状态
4. 注册资本总额、股东名称、认缴金额、持股比例，以及“由/增加至/变更为”等交易前后变化
5. 能帮助识别文件客观类型和交易事实的章节标题与核心事项

不要猜测模糊文字，不要进行档案分类，不要复述无关正文。每页最多120个汉字，使用紧凑纯文本。`,
        },
      ];

      batch.forEach((url, pageIndex) => {
        content.push(
          {
            type: 'text',
            text: `第${firstPage + pageIndex}页：`,
          },
          {
            type: 'image_url',
            image_url: { url, detail: PDF_VISUAL_DETAIL },
          }
        );
      });

      try {
        const response = await invokeChatCompletion({
          messages: [
            {
              role: 'system',
              content: '你是严谨的中文档案OCR助手，只记录图片中真实可见的信息。',
            },
            { role: 'user', content },
          ],
          model: 'doubao-seed-2-0-lite-260215',
          temperature: 0.1,
          maxOutputTokens: 1_200,
          customHeaders,
          timeoutMs: 120_000,
        });
        return {
          text: response.content.trim(),
          modelCall: response.diagnostics,
        };
      } catch (error) {
        console.error(`Scanned PDF batch ${batchIndex + 1} error:`, error);
        return { text: '', modelCall: null };
      }
    })
  );

  const extracted = batchResults.map(result => result.text).filter(Boolean);
  const modelCalls = batchResults.flatMap(result =>
    result.modelCall ? [result.modelCall] : []
  );
  if (extracted.length === 0) return { text: '', modelCalls };

  return {
    text: `[扫描PDF视觉分析：共分析${selectedUrls.length}页]\n${extracted.join('\n\n')}`,
    modelCalls,
  };
}

export interface ReadDocumentContentParams {
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** 小写扩展名，不含点。 */
  extension: string;
  customHeaders: Record<string, string>;
  /** 大文件转存临时目录时需要它；没有就跳过转存。 */
  projectId?: string;
  /** multipart 上传的原始文件。与 storageKey 至少要有一个。 */
  file?: File;
  /** 已存在 S3 的文件。与 file 至少要有一个。 */
  storageKey?: string;
  /** 调用方已经读进内存的内容，传进来可以少读一次。 */
  fileBuffer?: Buffer;
  measurePhase?: MeasurePhase;
}

export interface ReadDocumentContentResult {
  /** 交给模型的正文。读失败时退化为文件名——这是有意的，文件名本身也是证据。 */
  contentText: string;
  /** 正文前 500 字，给界面展示用。 */
  contentPreview: string;
  /** 图片类文件的签名 URL 或 Data URL，交给视觉模型。非图片为 undefined。 */
  imageDataUrl?: string;
  /** 过程中读进内存的文件内容，调用方可以接着用，避免重复读。 */
  fileBuffer?: Buffer;
  /** 大文件转存后会产生新的 storageKey，调用方必须用返回值覆盖自己的。 */
  storageKey?: string;
  /** OCR 过程中的模型调用，调用方需要并入自己的统计。 */
  modelCalls: ModelCallDiagnostics[];
}

export async function readDocumentContent(
  params: ReadDocumentContentParams
): Promise<ReadDocumentContentResult> {
  const {
    fileName,
    fileSize,
    mimeType,
    extension,
    customHeaders,
    projectId,
    file,
  } = params;
  const measurePhase = params.measurePhase ?? noMeasure;

  let contentText = '';
  let contentPreview = '';
  let imageDataUrl: string | undefined;
  let fileBuffer = params.fileBuffer;
  let storageKey = params.storageKey;
  const modelCalls: ModelCallDiagnostics[] = [];

  await measurePhase('read_and_parse_file', async () => {
    try {
      // 大文件（>5MB）的 multipart 上传：先上传 S3 临时目录，用签名 URL 替代 Base64 Data URL
      // 避免 Base64 膨胀（12MB → ~17MB 字符串）导致 FetchClient 超时 502
      const isLargeMultipart =
        !storageKey && file && fileSize > LARGE_FILE_THRESHOLD;
      if (isLargeMultipart && projectId) {
        storageKey = await measurePhase(
          'upload_temporary_file',
          () =>
            uploadTempFileFromBuffer({
              buffer: fileBuffer!,
              fileName,
              mimeType,
              projectId,
            }),
          'read_and_parse_file'
        );
      }

      const ensureFileBuffer = async () => {
        if (!fileBuffer) {
          fileBuffer = await measurePhase(
            'read_file_buffer',
            () =>
              storageKey
                ? readStoredFile(storageKey)
                : file!.arrayBuffer().then(value => Buffer.from(value)),
            'read_and_parse_file'
          );
        }
        return fileBuffer!;
      };

      if (['txt', 'md', 'csv', 'json', 'xml'].includes(extension)) {
        contentText = new TextDecoder('utf-8').decode(await ensureFileBuffer());
      } else if (isImageFile(extension)) {
        // S3 文件直接使用短期签名 URL，旧流程仍兼容 Data URL。
        imageDataUrl = storageKey
          ? await measurePhase(
              'generate_signed_file_url',
              () => getStoredFileUrl(storageKey!),
              'read_and_parse_file'
            )
          : `data:${mimeType};base64,${(await ensureFileBuffer()).toString('base64')}`;
        contentText = `[图片文件] 格式: ${extension.toUpperCase()}, 文件名: ${fileName}。请结合原始图片的场景、物体和可见文字进行分类。`;
      } else {
        // 签名 URL 只依赖 storageKey，和读取文件内容互不依赖。提前并行发起，
        // 这样扫描件回退到 Coze 解析时不必再串行等一次往返。带文字层的 PDF
        // 用不到它，多出的一次签名调用不在关键路径上；附 catch 防止未处理拒绝。
        let signedUrlPromise: Promise<string> | undefined;
        if (storageKey) {
          signedUrlPromise = getStoredFileUrl(storageKey);
          void signedUrlPromise.catch(() => undefined);
        }

        if (extension === 'pdf' && fileSize <= 25 * 1024 * 1024) {
          try {
            const localPdfBuffer = await ensureFileBuffer();
            const localPdf = await measurePhase(
              'extract_local_pdf_text',
              () => extractLocalPdfText(localPdfBuffer),
              'read_and_parse_file'
            );
            if (localPdf.text.trim().length >= 30) {
              contentText = localPdf.text;
            }
          } catch (localPdfError) {
            console.warn('Local PDF text extraction failed:', localPdfError);
          }
        }

        if (contentText.trim().length < 30) {
          // 扫描 PDF、Office 文件和本地解析失败的 PDF 回退到 Coze 解析服务。
          const pendingSignedUrl = signedUrlPromise;
          const sourceUrl = pendingSignedUrl
            ? await measurePhase(
                'generate_signed_file_url',
                () => pendingSignedUrl,
                'read_and_parse_file'
              )
            : `data:${mimeType};base64,${(await ensureFileBuffer()).toString('base64')}`;
          const fetchConfig = new Config({ timeout: 120_000, retryTimes: 1 });
          const fetchClient = new FetchClient(fetchConfig, customHeaders);

          try {
            const fetchResponse = await measurePhase(
              'fetch_document_content',
              () => fetchClient.fetch(sourceUrl),
              'read_and_parse_file'
            );
            const textItems = fetchResponse.content.filter(
              item => item.type === 'text'
            );
            contentText = textItems.map(item => item.text || '').join('\n');

            if (extension === 'pdf' && contentText.trim().length < 30) {
              const pageImageUrls = fetchResponse.content
                .filter(item => item.type === 'image')
                .map(
                  item =>
                    item.image?.image_url ||
                    item.image?.display_url ||
                    item.image?.thumbnail_display_url ||
                    item.url ||
                    ''
                )
                .filter((url): url is string => Boolean(url));

              const scanned = await measurePhase(
                'ocr_scanned_pdf',
                () => extractScannedPdfText(pageImageUrls, fileName, customHeaders),
                'read_and_parse_file'
              );
              modelCalls.push(...scanned.modelCalls);
              contentText = scanned.text || fileName;
            }
          } catch (fetchError) {
            console.error('FetchClient error:', fetchError);
            contentText = fileName;
          }
        }
      }

      contentPreview =
        contentText.slice(0, 500) + (contentText.length > 500 ? '...' : '');
    } catch (readError) {
      console.error('File read error:', readError);
      contentText = fileName;
    }
  });

  return {
    contentText,
    contentPreview,
    imageDataUrl,
    fileBuffer,
    storageKey,
    modelCalls,
  };
}
