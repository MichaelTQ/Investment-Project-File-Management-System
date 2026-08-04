import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLocalPdfText } from '../src/lib/classification/local-pdf-text';

function textPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${escaped.length + 32} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

test('本地 PDF 文字层可直接提取而无需远端 FetchClient', async () => {
  const result = await extractLocalPdfText(
    textPdf('Project initiation application approved')
  );
  assert.equal(result.pageCount, 1);
  assert.equal(result.processedPageCount, 1);
  assert.match(result.text, /Project initiation application approved/);
});

test('过大的 PDF 会安全回退而不是占用大量内存解析', async () => {
  const result = await extractLocalPdfText(Buffer.alloc(25 * 1024 * 1024 + 1));
  assert.equal(result.text, '');
  assert.match(result.skippedReason ?? '', /超过本地解析上限/);
});
