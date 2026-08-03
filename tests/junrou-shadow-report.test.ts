import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

interface ShadowCase {
  relativePath: string;
  sha256: string;
  textLayerCharacterCount: number;
  factTypeMatchesGold: boolean;
  contextMatchesGold: boolean;
  contextDecision: {
    selectedFolder: unknown;
  };
}

const projectRoot = process.cwd();
const report = JSON.parse(
  readFileSync(
    path.join(projectRoot, 'output/reports/junrou-shadow-evaluation.json'),
    'utf8'
  )
) as {
  schemaVersion: number;
  mode: string;
  summary: {
    evaluatedCaseCount: number;
    scannedPdfCount: number;
    factTypeCorrectCount: number;
    contextCoveredCount: number;
    contextCoveredCorrectCount: number;
  };
  cases: ShadowCase[];
};

test('君柔shadow报告来自当前六份真实金标准文件', () => {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, 'local-vision-ocr-context-shadow');
  assert.equal(report.summary.evaluatedCaseCount, 6);
  assert.equal(report.cases.length, 6);

  for (const item of report.cases) {
    const fileBuffer = readFileSync(
      path.join(projectRoot, '君柔档案', item.relativePath)
    );
    assert.equal(
      createHash('sha256').update(fileBuffer).digest('hex'),
      item.sha256,
      `原文件已变化，需重新运行shadow评测：${item.relativePath}`
    );
  }
});

test('六份PDF均需OCR，文档类型抽取全部命中', () => {
  assert.equal(report.summary.scannedPdfCount, 6);
  assert.equal(report.summary.factTypeCorrectCount, 6);
  assert.equal(
    report.cases.every(item => item.textLayerCharacterCount === 0),
    true
  );
  assert.equal(report.cases.every(item => item.factTypeMatchesGold), true);
});

test('上下文v5覆盖六个阶段文件夹金标准且全部命中', () => {
  assert.equal(report.summary.contextCoveredCount, 6);
  assert.equal(report.summary.contextCoveredCorrectCount, 6);
  const covered = report.cases.filter(
    item => item.contextDecision.selectedFolder
  );
  assert.equal(covered.length, 6);
  assert.equal(covered.every(item => item.contextMatchesGold), true);
});

test('Markdown报告明确记录Coze和非持久化边界', () => {
  const markdown = readFileSync(
    path.join(projectRoot, 'output/reports/JUNROU_SHADOW_EVALUATION.md'),
    'utf8'
  );
  assert.match(markdown, /6\/6/);
  assert.match(markdown, /不写入 Supabase/);
  assert.match(markdown, /不改变 Coze 环境/);
});
