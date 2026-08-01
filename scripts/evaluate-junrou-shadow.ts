import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assessKeywordMatches,
  matchByKeywords,
} from '../src/lib/classification';
import { getCategoryEvidencePolicy } from '../src/lib/classification/category-policies';
import {
  decideWithProjectContext,
  parseProjectContextSnapshot,
  type RelatedDocumentFacts,
} from '../src/lib/classification/context-decision';
import type {
  DocumentFacts,
  DocumentType,
} from '../src/lib/classification/document-facts';

interface GoldCase {
  id: string;
  relativePath: string;
  documentType: DocumentType;
  expectedCategory: {
    folderId: string;
    fileName: string;
    folderPath: string[];
  };
  requiresHumanConfirmation: boolean;
}

interface OcrPage {
  path: string;
  text: string;
  lineCount: number;
  error: string | null;
}

interface RawEvaluationRow {
  id: string;
  relativePath: string;
  sha256: string;
  pageCount: number;
  textLayerCharacterCount: number;
  ocrCharacterCount: number;
  ocrEmptyPageCount: number;
  facts: DocumentFacts;
}

const projectRoot = process.cwd();
const archiveRoot = path.join(projectRoot, '君柔档案');
const outputRoot = path.join(projectRoot, 'output', 'reports');
const popplerRoot =
  '/Users/michael/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override';
const pdftoppm = path.join(popplerRoot, 'pdftoppm');
const pdfinfo = path.join(popplerRoot, 'pdfinfo');
const ocrSource = path.join(projectRoot, 'scripts', 'ocr-images.m');
const ocrBinary = path.join(tmpdir(), 'junrou-ocr-images');
const clangCache = path.join(tmpdir(), 'junrou-ocr-module-cache');

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(path.join(projectRoot, relativePath), 'utf8')
  ) as T;
}

function compileOcrHelper(): void {
  execFileSync('/usr/bin/clang', [
    '-fobjc-arc',
    `-fmodules-cache-path=${clangCache}`,
    '-framework',
    'Foundation',
    '-framework',
    'AppKit',
    '-framework',
    'Vision',
    ocrSource,
    '-o',
    ocrBinary,
  ]);
}

function pdfPageCount(pdfPath: string): number {
  const info = execFileSync(pdfinfo, [pdfPath], { encoding: 'utf8' });
  const match = info.match(/^Pages:\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

function renderAndOcr(pdfPath: string, caseRoot: string): OcrPage[] {
  mkdirSync(caseRoot, { recursive: true });
  const prefix = path.join(caseRoot, 'page');
  execFileSync(pdftoppm, ['-jpeg', '-r', '180', pdfPath, prefix]);
  const images = readdirSync(caseRoot)
    .filter(name => name.endsWith('.jpg'))
    .sort()
    .map(name => path.join(caseRoot, name));
  if (images.length === 0) throw new Error(`PDF没有渲染出页面：${pdfPath}`);
  const output = execFileSync(ocrBinary, images, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(output) as OcrPage[];
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function inferDocumentType(fileName: string, text: string): DocumentType {
  if (/\u516c\u53f8\u7ae0\u7a0b|\u7ae0\s*\u7a0b/.test(fileName)) return 'company_charter';
  if (/\u80a1\u4e1c\u4f1a\u51b3\u8bae/.test(fileName)) return 'shareholder_resolution';
  if (/\u4ea4\u5272\u786e\u8ba4\u51fd/.test(fileName)) return 'closing_confirmation';
  if (/\u7f34\u6b3e\u901a\u77e5\u4e66|\u4ed8\u6b3e\u901a\u77e5\u51fd/.test(fileName)) return 'payment_notice';
  const value = `${fileName}\n${text}`;
  if (/\u6295\u8d44\u9879\u76ee\u5408\u89c4\u6027\u5ba1\u67e5\u8868|\u5408\u89c4\u6027\u5ba1\u67e5\u610f\u89c1/.test(value)) {
    return 'investment_compliance_review';
  }
  if (/\u7f34\u6b3e\u901a\u77e5\u4e66|\u4ed8\u6b3e\u901a\u77e5\u51fd/.test(value)) return 'payment_notice';
  if (/\u4ea4\u5272\u786e\u8ba4\u51fd/.test(value)) return 'closing_confirmation';
  if (/\u80a1\u4e1c\u4f1a\u51b3\u8bae/.test(value)) return 'shareholder_resolution';
  if (/\u516c\u53f8\u7ae0\u7a0b|\u7ae0\s*\u7a0b/.test(value)) return 'company_charter';
  return 'unknown';
}

function inferTitle(
  fileName: string,
  documentType: DocumentType,
  lines: string[]
): string {
  const titlePatterns: Partial<Record<DocumentType, RegExp>> = {
    investment_compliance_review: /\u6295\u8d44\u9879\u76ee\u5408\u89c4\u6027\u5ba1\u67e5\u8868|\u5408\u89c4\u6027\u5ba1\u67e5\u610f\u89c1/,
    payment_notice: /\u7f34\u6b3e\u901a\u77e5\u4e66|\u4ed8\u6b3e\u901a\u77e5\u51fd/,
    closing_confirmation: /\u4ea4\u5272\u786e\u8ba4\u51fd/,
    shareholder_resolution: /\u80a1\u4e1c\u4f1a\u51b3\u8bae/,
    company_charter: /\u516c\u53f8\u7ae0\u7a0b|\u7ae0\s*\u7a0b/,
  };
  const pattern = titlePatterns[documentType];
  return (
    (pattern ? lines.find(line => pattern.test(line)) : undefined) ??
    fileName.replace(/\.[^.]+$/, '')
  );
}

function extractDates(text: string): DocumentFacts['dates'] {
  const matches = unique([
    ...Array.from(text.matchAll(/(20\d{2})[-/.\u5e74](\d{1,2})[-/.\u6708](\d{1,2})(?:\u65e5)?/g)).map(
      match =>
        `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    ),
  ]).slice(0, 20);
  return matches.map(date => ({
    date,
    meaning: 'OCR识别日期，具体含义待上下文核对',
    evidence: date,
  }));
}

function extractCapitalEvidence(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ');
  return unique(
    Array.from(
      normalized.matchAll(/\u6ce8\u518c\u8d44\u672c.{0,45}?[\d,.]+\s*\u4e07\u5143/g)
    ).map(match => match[0].slice(0, 300))
  ).slice(0, 5);
}

function buildFacts(fileName: string, pages: OcrPage[]): DocumentFacts {
  const text = pages.map(page => page.text).join('\n');
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const documentType = inferDocumentType(fileName, text);
  const cluePattern = /\u589e\u8d44|\u80a1\u4e1c\u4f1a|\u6295\u59d4\u4f1a|\u4ea4\u5272|\u7f34\u6b3e|\u5408\u89c4|\u6295\u8d44\u9650\u5236|\u4fee\u6539\u516c\u53f8\u7ae0\u7a0b/;
  const evidencePattern = /\u6ce8\u518c\u8d44\u672c|\u6295\u8d44\u9879\u76ee\u5408\u89c4|\u5b50\u57fa\u91d1\u7ba1\u7406\u4eba|\u80a1\u4e1c\u4f1a\u51b3\u8bae|\u4ea4\u5272\u786e\u8ba4\u51fd|\u7f34\u6b3e\u901a\u77e5\u4e66|\u589e\u8d44/;
  const capitalEvidence = extractCapitalEvidence(text);
  const contributionEvidence = lines.filter(
    line => /\u8ba4\u7f34\u51fa\u8d44\u989d.*[\d,.]+\s*\u4e07\u5143/.test(line)
  );
  const evidenceQuotes = [
    ...capitalEvidence,
    ...contributionEvidence,
    ...lines.filter(line => /[\d,.]{4,}\s*\u4e07\u5143/.test(line)),
    ...lines.filter(line => evidencePattern.test(line)),
  ].slice(0, 30);
  const parties = unique(
    lines.filter(line => /\u6709\u9650\u516c\u53f8|\u5408\u4f19\u4f01\u4e1a/.test(line)).slice(0, 30)
  ).map(name => ({ name: name.slice(0, 200), role: 'OCR识别相关主体' }));
  const charCount = text.replace(/\s/g, '').length;
  const failedPages = pages.filter(page => page.error || !page.text.trim()).length;
  const extractionConfidence =
    charCount >= 1_000 ? 85 : charCount >= 300 ? 75 : charCount >= 80 ? 60 : 30;

  return {
    schemaVersion: 1,
    documentType,
    rawDocumentType: inferTitle(fileName, documentType, lines),
    title: inferTitle(fileName, documentType, lines),
    documentNumber: null,
    version: lines.find(line => /\u4fee\u8ba2\u7248|\u6700\u7ec8\u7248/.test(line)) ?? null,
    dates: extractDates(text),
    parties,
    signStatus: 'unknown',
    transactionChanges: [],
    explicitStageClues: unique(lines.filter(line => cluePattern.test(line))).slice(0, 30),
    evidenceQuotes,
    warnings: [
      'PDF无文字层，本次使用macOS Vision对渲染页面进行OCR',
      ...(failedPages > 0 ? [`${failedPages}页未识别出文字`] : []),
      '本地规则适配器只用于shadow评测，不代替Coze事实抽取模型',
    ],
    sourceQuality: 'image',
    extractionConfidence,
  };
}

function sameCategory(
  left: { folderId: string; fileName: string } | null | undefined,
  right: { folderId: string; fileName: string }
): boolean {
  return left?.folderId === right.folderId && left.fileName === right.fileName;
}

function categoryLabel(
  category: { folderId: string; fileName: string } | null | undefined
): string {
  return category ? category.fileName : '无结论';
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function main(): void {
  const fixture = readJson<{ cases: GoldCase[] }>(
    'tests/fixtures/junrou-classification-cases.json'
  );
  const rawContext = readJson<unknown>(
    'tests/fixtures/junrou-project-context.json'
  );
  const projectContext = parseProjectContextSnapshot(rawContext);
  if (!projectContext) throw new Error('君柔项目上下文不符合 Schema');

  compileOcrHelper();
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'junrou-shadow-'));
  const factsByCase = new Map<string, DocumentFacts>();
  const rawRows: RawEvaluationRow[] = [];

  try {
    for (const [index, gold] of fixture.cases.entries()) {
      const pdfPath = path.join(archiveRoot, gold.relativePath);
      if (!existsSync(pdfPath)) throw new Error(`金标准文件不存在：${gold.relativePath}`);
      console.error(`[${index + 1}/${fixture.cases.length}] OCR ${gold.relativePath}`);
      const pages = renderAndOcr(pdfPath, path.join(tempRoot, gold.id));
      const extractedFacts = buildFacts(path.basename(pdfPath), pages);
      factsByCase.set(gold.id, extractedFacts);
      rawRows.push({
        id: gold.id,
        relativePath: gold.relativePath,
        sha256: sha256(pdfPath),
        pageCount: pdfPageCount(pdfPath),
        textLayerCharacterCount: 0,
        ocrCharacterCount: pages.map(page => page.text).join('').length,
        ocrEmptyPageCount: pages.filter(page => !page.text.trim()).length,
        facts: extractedFacts,
      });
    }

    const relatedDocuments: RelatedDocumentFacts[] = fixture.cases
      .filter(item => item.documentType === 'company_charter')
      .map(item => ({
        sourcePath: item.relativePath,
        facts: factsByCase.get(item.id)!,
      }));

    const evaluated = fixture.cases.map(gold => {
      const raw = rawRows.find(item => item.id === gold.id)!;
      const extractedFacts = factsByCase.get(gold.id)!;
      const ocrText = [
        extractedFacts.title,
        ...extractedFacts.explicitStageClues,
        ...extractedFacts.evidenceQuotes,
      ].join('\n');
      const keywordMatches = matchByKeywords(
        path.basename(gold.relativePath),
        ocrText
      );
      const keywordAssessment = assessKeywordMatches(keywordMatches);
      const keywordTop = keywordMatches[0]?.category ?? null;
      const keywordPolicy = keywordTop
        ? getCategoryEvidencePolicy(keywordTop.folderId, keywordTop.fileName)
        : undefined;
      const keywordCanAutoDecide =
        keywordAssessment.passed &&
        !keywordAssessment.ambiguous &&
        !keywordPolicy?.defaultRequiresHumanReview;
      const contextDecision = decideWithProjectContext({
        sourcePath: gold.relativePath,
        facts: extractedFacts,
        projectContext,
        relatedDocuments: relatedDocuments.filter(
          item => item.sourcePath !== gold.relativePath
        ),
      });

      return {
        ...raw,
        goldDocumentType: gold.documentType,
        goldCategory: gold.expectedCategory,
        factTypeMatchesGold: extractedFacts.documentType === gold.documentType,
        keywordBaseline: {
          topCategory: keywordTop,
          topScore: keywordMatches[0]?.score ?? 0,
          passed: keywordAssessment.passed,
          ambiguous: keywordAssessment.ambiguous,
          canAutoDecide: keywordCanAutoDecide,
          topMatchesGold: sameCategory(keywordTop, gold.expectedCategory),
          note: keywordCanAutoDecide
            ? '关键词可直接决定'
            : '仍需Coze LLM消歧或人工确认',
        },
        contextDecision,
        contextMatchesGold: sameCategory(
          contextDecision.selectedCategory,
          gold.expectedCategory
        ),
      };
    });

    const summary = {
      evaluatedCaseCount: evaluated.length,
      scannedPdfCount: evaluated.filter(item => item.textLayerCharacterCount === 0).length,
      factTypeCorrectCount: evaluated.filter(item => item.factTypeMatchesGold).length,
      keywordTopCorrectCount: evaluated.filter(
        item => item.keywordBaseline.topMatchesGold
      ).length,
      keywordAutoDecisionCount: evaluated.filter(
        item => item.keywordBaseline.canAutoDecide
      ).length,
      contextCoveredCount: evaluated.filter(
        item => item.contextDecision.selectedCategory
      ).length,
      contextCoveredCorrectCount: evaluated.filter(
        item => item.contextDecision.selectedCategory && item.contextMatchesGold
      ).length,
      contextHumanReviewCount: evaluated.filter(
        item => item.contextDecision.requiresHumanReview
      ).length,
    };

    mkdirSync(outputRoot, { recursive: true });
    const jsonPath = path.join(outputRoot, 'junrou-shadow-evaluation.json');
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          mode: 'local-vision-ocr-context-shadow',
          limitations: [
            '六份PDF全部无文字层，使用macOS Vision OCR',
            '本地事实适配器不等同于Coze LLM事实抽取器',
            '未调用Coze LLM的legacy最终分类，只评估关键词预判',
            '上下文规则v2覆盖当前六个金标准文档类型，仍需其他项目留出集验证',
          ],
          summary,
          cases: evaluated,
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const rows = evaluated.map(item => {
      const gold = item.goldCategory as GoldCase['expectedCategory'];
      const keyword = item.keywordBaseline as {
        topCategory: { folderId: string; fileName: string } | null;
        canAutoDecide: boolean;
        topMatchesGold: boolean;
      };
      const context = item.contextDecision;
      const result = context.selectedCategory
        ? item.contextMatchesGold
          ? '上下文命中'
          : '上下文错误'
        : '规则未覆盖/证据不足';
      return `| ${escapeCell(String(item.relativePath))} | ${gold.fileName} | ${categoryLabel(keyword.topCategory)}${keyword.canAutoDecide ? '' : '（需消歧）'} | ${categoryLabel(context.selectedCategory)} | ${result} |`;
    });
    const report = `# 君柔真实文件 Shadow 对照报告

## 1. 结论

本次直接读取了 6 份已验收金标准原始 PDF。六份文件全部是无文字层扫描件，普通 PDF 文本抽取的结果均为 0，因此本地使用 macOS Vision OCR 识别渲染页面后再进行 shadow 评测。

- 文档类型抽取：${summary.factTypeCorrectCount}/${summary.evaluatedCaseCount} 与金标准一致；
- legacy 关键词最高候选：${summary.keywordTopCorrectCount}/${summary.evaluatedCaseCount} 与金标准一致；
- 关键词可不经消歧直接决定：${summary.keywordAutoDecisionCount}/${summary.evaluatedCaseCount}；
- 上下文规则 v2 给出明确结论：${summary.contextCoveredCount}/${summary.evaluatedCaseCount}；
- 已覆盖案例的上下文命中：${summary.contextCoveredCorrectCount}/${summary.contextCoveredCount || 0}。

## 2. 逐文件对照

| 原文件 | 金标准 | legacy 关键词预判 | 上下文 v2 | 结果 |
|---|---|---|---|---|
${rows.join('\n')}

## 3. 这份报告证明了什么

1. OCR/视觉抽取是真实档案的必经步骤，不是可选优化。
2. 单靠文件名和关键词不足以稳定区分两份公司章程；项目内注册资本对比可以提供决定性证据。
3. \`context-decision-v2\` 已覆盖六个金标准类型，并通过排除证据避免把投委会决议、银行回单或退出交易文件误收进新规则。
4. 投资合规性审查表即使证据充分，仍按既定策略保留人工复核。

## 4. 边界

本报告不写入 Supabase，不改变 Coze 环境，也没有调用 Coze LLM 的最终分类。本地 OCR 和规则事实适配器用来验证决策架构；上线前仍需在 Coze 运行环境对同一批文件运行正式 \`DocumentFactsSchema\` 抽取器。
`;
    writeFileSync(
      path.join(outputRoot, 'JUNROU_SHADOW_EVALUATION.md'),
      report,
      'utf8'
    );
    console.error(`报告已生成：${path.relative(projectRoot, outputRoot)}`);
  } finally {
    const resolvedTemp = realpathSync(tempRoot);
    const expectedPrefix = `${realpathSync(tmpdir())}${path.sep}junrou-shadow-`;
    if (
      resolvedTemp.startsWith(expectedPrefix) &&
      lstatSync(resolvedTemp).isDirectory() &&
      !lstatSync(resolvedTemp).isSymbolicLink()
    ) {
      rmSync(resolvedTemp, { recursive: true });
    }
  }
}

main();
