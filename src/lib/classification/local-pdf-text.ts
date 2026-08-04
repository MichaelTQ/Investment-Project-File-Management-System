const LOCAL_PDF_MAX_PAGES = 100;
const LOCAL_PDF_MAX_CHARACTERS = 12_000;
const LOCAL_PDF_MAX_BYTES = 25 * 1024 * 1024;

export interface LocalPdfTextResult {
  text: string;
  pageCount: number;
  processedPageCount: number;
  truncated: boolean;
  skippedReason?: string;
}

interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/**
 * 优先读取 PDF 自带文字层。扫描件或解析失败时返回空文本，由调用方回退到
 * Coze FetchClient/OCR；这里不渲染页面，因此不依赖 Canvas。
 */
export async function extractLocalPdfText(
  buffer: Buffer
): Promise<LocalPdfTextResult> {
  if (buffer.byteLength > LOCAL_PDF_MAX_BYTES) {
    return {
      text: '',
      pageCount: 0,
      processedPageCount: 0,
      truncated: false,
      skippedReason: `PDF 超过本地解析上限 ${LOCAL_PDF_MAX_BYTES} bytes`,
    };
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  try {
    const document = await loadingTask.promise;
    const pageCount = document.numPages;
    const pageLimit = Math.min(document.numPages, LOCAL_PDF_MAX_PAGES);
    const pages: string[] = [];
    let characterCount = 0;
    let processedPageCount = 0;
    let truncated = document.numPages > pageLimit;

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const rawItem of content.items) {
        const item = rawItem as PdfTextItemLike;
        if (!item.str) continue;
        parts.push(item.str, item.hasEOL ? '\n' : ' ');
      }
      const pageText = parts.join('').replace(/[ \t]+\n/g, '\n').trim();
      processedPageCount += 1;
      if (pageText) {
        const remaining = LOCAL_PDF_MAX_CHARACTERS - characterCount;
        if (remaining <= 0) {
          truncated = true;
          page.cleanup();
          break;
        }
        const selected = pageText.slice(0, remaining);
        pages.push(`[第${pageNumber}页]\n${selected}`);
        characterCount += selected.length;
        if (selected.length < pageText.length) {
          truncated = true;
          page.cleanup();
          break;
        }
      }
      page.cleanup();
    }

    await document.destroy();
    return {
      text: pages.join('\n\n'),
      pageCount,
      processedPageCount,
      truncated,
    };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
