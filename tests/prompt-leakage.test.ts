import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import { buildStageDecisionPrompt } from '../src/lib/classification/llm-stage-decision';
import { describeResolvedEvidence, resolveEvidence } from '../src/lib/classification/minimal/evidence';
import type { MinimalDocument } from '../src/lib/classification/minimal/store';

/**
 * 防作弊回归测试：目录名不得进入提示词。
 *
 * 用户按文件夹上传时 sourcePath 是 webkitRelativePath，形如
 * `君柔档案/投资决策/xxx.pdf`，目录名就是人工归档结果（评测里的标准答案）。
 * 一旦泄漏，模型无需推理即可答对，准确率虚高且上线后失真。
 */

const GOLD_DIRECTORIES = [
  '投资决策',
  '投资实施',
  '尽职调查',
  '项目立项',
  '立项前',
  '君柔档案',
];

function facts(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType: 'company_charter',
    rawDocumentType: '公司章程',
    title: '君柔科技公司章程',
    documentNumber: null,
    version: null,
    dates: [],
    parties: [],
    signStatus: 'sealed',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: [],
    warnings: [],
    sourceQuality: 'text',
    extractionConfidence: 90,
    ...overrides,
  };
}

function assertNoGoldDirectory(text: string, context: string) {
  for (const directory of GOLD_DIRECTORIES) {
    assert.equal(
      text.includes(directory),
      false,
      `${context}泄漏了归档目录名“${directory}”，模型可据此直接读出答案`
    );
  }
  assert.equal(text.includes('/'), false, `${context}仍包含路径分隔符`);
}

test('待归档文件本身只给文件名，不给目录路径', () => {
  const messages = buildStageDecisionPrompt({
    sourcePath: '君柔档案/投资决策/财务资料/君柔科技公司章程.pdf',
    facts: facts(),
  });
  // 只查用户提示（装数据的那一半）。系统提示里的阶段定义本来就含"投资决策"
  // 这类词，那是阶段说明，不是当前文件的答案。
  const userPrompt = String(messages[1].content);

  assert.equal(userPrompt.includes('君柔科技公司章程.pdf'), true);
  assertNoGoldDirectory(userPrompt, '待归档文件路径');
});

test('关联文件清单同样只给文件名', () => {
  const messages = buildStageDecisionPrompt({
    sourcePath: '章程.pdf',
    facts: facts(),
    relatedDocuments: [
      {
        sourcePath: '君柔档案/投资实施/股东会决议.pdf',
        facts: facts({ documentType: 'shareholder_resolution' }),
      },
    ],
  });
  // 只查用户提示（装数据的那一半）。系统提示里的阶段定义本来就含"投资决策"
  // 这类词，那是阶段说明，不是当前文件的答案。
  const userPrompt = String(messages[1].content);

  assert.equal(userPrompt.includes('股东会决议.pdf'), true);
  assertNoGoldDirectory(userPrompt, '关联文件清单');
});

test('代码算出的锚点结论里也不带目录路径', () => {
  const current: MinimalDocument = {
    sourcePath: '君柔档案/投资决策/章程.pdf',
    stage: null,
    updatedAt: 0,
    facts: facts({
      evidenceQuotes: ['注册资本为人民币 1000 万元'],
    }),
  };
  const anchor: MinimalDocument = {
    sourcePath: '君柔档案/投资实施/股东会决议.pdf',
    stage: null,
    updatedAt: 0,
    facts: facts({
      documentType: 'shareholder_resolution',
      transactionChanges: [
        {
          field: '注册资本',
          before: '1000万元',
          after: '1500万元',
          evidence: '注册资本由1000万元增加至1500万元',
        },
      ],
    }),
  };

  const described = describeResolvedEvidence(resolveEvidence(current, [anchor]));
  assertNoGoldDirectory(described, '代码结论');
});

/**
 * 诊断文案只能陈述代码真的看见的东西。
 *
 * 反面教材：把"缺少一份记载注册资本变更前后值的股东会决议或增资协议"写死在
 * 分支里。代码并不知道这个项目该有哪些文件，这类句子读起来像结论，实际是模板，
 * 会让人误以为系统已经查证过档案应有的构成。
 */

const PRESCRIPTIVE_PHRASES = ['应有', '应当有', '通常应', '缺少一份'];

test('找不到锚点时只陈述观察到的事实，不预设项目该有哪些文件', () => {
  const lonely: MinimalDocument = {
    sourcePath: '公司章程.pdf',
    stage: null,
    updatedAt: 0,
    facts: facts(),
  };
  const other: MinimalDocument = {
    sourcePath: '营业执照.pdf',
    stage: null,
    updatedAt: 0,
    facts: facts({ documentType: 'business_license', title: '营业执照' }),
  };

  const detail =
    resolveEvidence(lonely, [other]).anchorDiagnostic?.detail ?? '';

  // 说清看见了哪几份文件。
  assert.match(detail, /营业执照\.pdf/);
  assert.match(detail, /1 份/);
  for (const phrase of PRESCRIPTIVE_PHRASES) {
    assert.equal(
      detail.includes(phrase),
      false,
      `诊断里出现了预设该有什么文件的措辞“${phrase}”`
    );
  }
});
