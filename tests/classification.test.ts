import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessKeywordMatches,
  getCategoryByLlmIndex,
  matchByKeywords,
  normalizeConfidence,
} from '../src/lib/classification';
import {
  FLAT_FILE_CATEGORIES,
  type FlatFileCategory,
} from '../src/lib/folder-structure';
import {
  getCategoryEvidencePolicy,
  INVESTMENT_COMPLIANCE_REVIEW_POLICY,
} from '../src/lib/classification/category-policies';

test('同一类别的重复词和嵌套词只计最具体的一次', () => {
  const category: FlatFileCategory = {
    folderPath: ['投资项目档案', '测试'],
    folderId: 'test',
    fileName: '立项申请书',
    keywords: ['立项', '申请', '立项申请', '立项申请'],
  };

  const [match] = matchByKeywords('立项申请.pdf', '', [category]);

  assert.equal(match.score, 3);
  assert.deepEqual(match.fileNameMatches, ['立项申请']);
});

test('退出投委会决议不再与普通投委会决议并列', () => {
  const matches = matchByKeywords('退出投委会决议.pdf', '');

  assert.equal(matches[0].category.folderId, 'exit-decision-docs');
  assert.equal(matches[0].category.fileName, '退出投委会决议');
  assert.equal(assessKeywordMatches(matches).passed, true);
});

test('未注明投资或退出阶段的转账凭证必须进入 AI 消歧', () => {
  const matches = matchByKeywords('转账凭证.pdf', '');
  const assessment = assessKeywordMatches(matches);

  assert.equal(matches[0].category.fileName, '转账凭证');
  assert.equal(matches[1].category.fileName, '转账凭证');
  assert.equal(matches[0].score, matches[1].score);
  assert.equal(assessment.ambiguous, true);
  assert.equal(assessment.passed, false);
});

test('项目公司章程不会因嵌套关键词被旧类别抢先自动归档', () => {
  const matches = matchByKeywords('项目公司章程.pdf', '');

  assert.equal(matches[0].score, 3);
  assert.equal(matches[1].score, 3);
  assert.equal(assessKeywordMatches(matches).passed, false);
});

test('最高分并列时必须进入 AI 消歧', () => {
  const categories: FlatFileCategory[] = [
    {
      folderPath: ['投资项目档案', '甲'],
      folderId: 'a',
      fileName: '甲类',
      keywords: ['决议'],
    },
    {
      folderPath: ['投资项目档案', '乙'],
      folderId: 'b',
      fileName: '乙类',
      keywords: ['决议'],
    },
  ];
  const matches = matchByKeywords('决议.pdf', '决议', categories);

  assert.equal(matches[0].score, 4);
  assert.equal(assessKeywordMatches(matches).passed, false);

  const thresholdMatches = matches.map(match => ({ ...match, score: 6 }));
  assert.deepEqual(assessKeywordMatches(thresholdMatches), {
    passed: false,
    scoreGap: 0,
    ambiguous: true,
  });
});

test('LLM 类别索引可精确保留退出阶段的同名转账凭证', () => {
  const exitTransferIndex = FLAT_FILE_CATEGORIES.findIndex(
    category =>
      category.folderId === 'exit-implementation' &&
      category.fileName === '转账凭证'
  );

  const result = getCategoryByLlmIndex(exitTransferIndex + 1);

  assert.equal(result.categoryIndex, exitTransferIndex + 1);
  assert.equal(result.category?.folderId, 'exit-implementation');
  assert.equal(result.category?.fileName, '转账凭证');
});

test('LLM 置信度会校验并限制在 0 到 100', () => {
  assert.equal(normalizeConfidence(0), 0);
  assert.equal(normalizeConfidence('81.6'), 82);
  assert.equal(normalizeConfidence(120), 100);
  assert.equal(normalizeConfidence(-5), 0);
  assert.equal(normalizeConfidence('invalid'), 0);
});

test('投资合规性审查表可被识别，但不会仅凭正文关键词自动归档', () => {
  const matches = matchByKeywords(
    '中山火炬电子产业基金管理有限公司-君柔科技.pdf',
    '投资项目合规性审查表 投资方案 子基金管理人意见'
  );

  assert.equal(matches[0].category.folderId, 'decision-meeting');
  assert.equal(matches[0].category.fileName, '投资合规性审查表');
  assert.equal(assessKeywordMatches(matches).passed, false);
});

test('投资合规性审查规则要求项目级证据并默认人工复核', () => {
  assert.equal(
    INVESTMENT_COMPLIANCE_REVIEW_POLICY.categoryKey,
    'decision-meeting:投资合规性审查表'
  );
  assert.equal(
    INVESTMENT_COMPLIANCE_REVIEW_POLICY.documentTypes.includes(
      'investment_compliance_review'
    ),
    true
  );
  assert.equal(
    INVESTMENT_COMPLIANCE_REVIEW_POLICY.requiredEvidenceAny.length >= 2,
    true
  );
  assert.equal(
    INVESTMENT_COMPLIANCE_REVIEW_POLICY.negativeEvidence.some(evidence =>
      evidence.includes('法律尽职调查')
    ),
    true
  );
  assert.equal(
    INVESTMENT_COMPLIANCE_REVIEW_POLICY.defaultRequiresHumanReview,
    true
  );
  assert.equal(
    getCategoryEvidencePolicy('decision-meeting', '投资合规性审查表')
      ?.policyVersion,
    'investment-compliance-review-v1'
  );
  assert.equal(
    getCategoryEvidencePolicy('decision-meeting', '投资建议书'),
    undefined
  );
});
