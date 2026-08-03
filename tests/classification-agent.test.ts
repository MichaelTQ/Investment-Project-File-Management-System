import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runClassificationAgent } from '../src/lib/classification/classification-agent';
import {
  parseProjectContextSnapshot,
  type ProjectContextSnapshot,
} from '../src/lib/classification/context-decision';
import type { DocumentFacts } from '../src/lib/classification/document-facts';

const projectRoot = process.cwd();
const shadowReport = JSON.parse(
  readFileSync(
    path.join(projectRoot, 'output/reports/junrou-shadow-evaluation.json'),
    'utf8'
  )
) as {
  cases: Array<{
    id: string;
    relativePath: string;
    facts: DocumentFacts;
  }>;
};
const projectContext = parseProjectContextSnapshot(
  JSON.parse(
    readFileSync(
      path.join(projectRoot, 'tests/fixtures/junrou-project-context.json'),
      'utf8'
    )
  )
) as ProjectContextSnapshot;

function reportCase(id: string) {
  const item = shadowReport.cases.find(candidate => candidate.id === id);
  if (!item) throw new Error(`报告中缺少案例：${id}`);
  return item;
}

test('Agent会动态检索多份关联章程并在获得决定性证据后停止', async () => {
  const pre = reportCase('junrou-charter-pre-transaction');
  const post = reportCase('junrou-charter-post-transaction');
  const result = await runClassificationAgent({
    sourcePath: pre.relativePath,
    facts: pre.facts,
    projectContext,
    availableRelatedDocuments: [
      {
        sourcePath: '关联文件/同版本章程.pdf',
        facts: pre.facts,
      },
      {
        sourcePath: post.relativePath,
        facts: post.facts,
      },
    ],
  });

  assert.equal(result.status, 'decided');
  assert.equal(result.decision.selectedFolder?.name, '投资决策');
  assert.equal(result.rounds, 2);
  assert.equal(result.selectedRelatedDocuments.length, 2);
  assert.equal(
    result.trace.filter(step => step.node === 'context_decision').length,
    2
  );
  assert.equal(result.trace.at(-1)?.node, 'complete');
  assert.equal(result.llmCallCount, 0);
});

test('Agent在章程缺少关联文件时不猜测并转人工', async () => {
  const pre = reportCase('junrou-charter-pre-transaction');
  const result = await runClassificationAgent({
    sourcePath: pre.relativePath,
    facts: pre.facts,
    projectContext,
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.decision.status, 'insufficient');
  assert.equal(result.decision.selectedFolder, null);
  assert.equal(result.trace.at(-1)?.node, 'human_review');
  assert.equal(result.selectedRelatedDocuments.length, 0);
});

test('Agent可用股东会决议的注册资本变化识别增资后章程', async () => {
  const post = reportCase('junrou-charter-post-transaction');
  const resolution = reportCase('junrou-shareholder-resolution');
  const result = await runClassificationAgent({
    sourcePath: post.relativePath,
    facts: post.facts,
    availableRelatedDocuments: [
      { sourcePath: resolution.relativePath, facts: resolution.facts },
    ],
  });

  assert.equal(result.status, 'decided');
  assert.equal(
    result.decision.selectedFolder?.name,
    '投资实施'
  );
  assert.equal(result.selectedRelatedDocuments.length, 1);
  assert.match(result.decision.evidence.join('\n'), /注册资本由 11\.73624 万元增至 13\.04027 万元/);
});

test('Agent对合规审查表给出建议但遵守默认人工复核策略', async () => {
  const compliance = reportCase('junrou-investment-compliance-review');
  const result = await runClassificationAgent({
    sourcePath: compliance.relativePath,
    facts: compliance.facts,
    projectContext,
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(
    result.decision.selectedFolder?.name,
    '投资决策'
  );
  assert.equal(result.decision.status, 'decided');
  assert.equal(result.decision.requiresHumanReview, true);
  assert.equal(result.trace.at(-1)?.node, 'human_review');
});

test('Agent对股东会增资决议给出投资实施建议', async () => {
  const resolution = reportCase('junrou-shareholder-resolution');
  const result = await runClassificationAgent({
    sourcePath: resolution.relativePath,
    facts: resolution.facts,
    projectContext,
  });

  assert.equal(result.status, 'decided');
  assert.deepEqual(result.requestedEvidence, [
    'related_document:capital_increase_agreement',
    'related_document:company_charter',
    'related_document:shareholder_agreement',
    'project_context:direct_events',
    'project_context:document_relations',
    'project_event:shareholders_approved_transaction',
  ]);
  assert.equal(result.decision.selectedFolder?.name, '投资实施');
  assert.equal(result.trace.at(-1)?.node, 'complete');
  assert.equal(result.llmCallCount, 0);
});

test('Agent将立项表决结果直接归入项目立项文件夹', async () => {
  const result = await runClassificationAgent({
    sourcePath: '佰特微立项表决结果.pdf',
    facts: {
      schemaVersion: 1,
      documentType: 'voting_result',
      rawDocumentType: '立项表决结果',
      title: '佰特微医疗B轮融资项目立项表决结果',
      documentNumber: null,
      version: null,
      dates: [],
      parties: [],
      signStatus: 'unknown',
      transactionChanges: [],
      explicitStageClues: ['立项会委员对项目立项进行表决'],
      evidenceQuotes: ['表决结果：3票同意，0票不同意', '本项目通过立项'],
      warnings: [],
      sourceQuality: 'text',
      extractionConfidence: 95,
    },
  });

  assert.equal(result.status, 'decided');
  assert.equal(result.decision.status, 'decided');
  assert.equal(result.decision.businessStage, 'initiation');
  assert.equal(result.decision.selectedFolder?.folderId, 'project-initiation');
  assert.equal(result.decision.routingMethod, 'stage_policy');
  assert.equal(result.trace.at(-1)?.node, 'complete');
});
