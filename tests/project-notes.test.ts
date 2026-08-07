import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeProjectNotes,
  MAX_PROJECT_NOTES_LENGTH,
  normalizeProjectNotes,
} from '../src/lib/classification/project-notes';
import { buildStageDecisionPrompt } from '../src/lib/classification/llm-stage-decision';
import { buildFolderStagePrompt } from '../src/lib/classification/folder-stage';
import type { DocumentFacts } from '../src/lib/classification/document-facts';

function facts(): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType: 'company_charter',
    rawDocumentType: '公司章程',
    title: '公司章程',
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
  };
}

test('超过上限的备注被截断，不会撑爆提示词', () => {
  const long = '口'.repeat(MAX_PROJECT_NOTES_LENGTH + 200);
  assert.equal(normalizeProjectNotes(long).length, MAX_PROJECT_NOTES_LENGTH);
});

test('空备注不产生空标题', () => {
  // 只有标题没有内容，会让模型以为这里本该有东西却缺失了。
  for (const value of ['', '   ', null, undefined, 42]) {
    assert.equal(describeProjectNotes(value as string), '');
  }
});

test('备注划清了口径与事实的边界', () => {
  const block = describeProjectNotes('FA 的财务尽调底稿归入投资决策');
  assert.match(block, /本项目的归档口径/);
  assert.match(block, /FA 的财务尽调底稿归入投资决策/);
  // 口径管"这类文件放哪"，不管"这份文件是什么"——否则一句备注就能让模型
  // 无视文件里白纸黑字写着的内容。
  assert.match(block, /不能推翻文件自身记载的事实/);
});

test('备注进入判阶段的提示词', () => {
  const userPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: 'a.pdf',
      facts: facts(),
      projectNotes: 'FA 的财务尽调底稿归入投资决策',
    })[1].content
  );
  assert.match(userPrompt, /FA 的财务尽调底稿归入投资决策/);
});

test('备注进入文件夹判阶段的提示词', () => {
  const userPrompt = String(
    buildFolderStagePrompt(['协议word版本'], '协议 Word 版归入投资实施')[1].content
  );
  assert.match(userPrompt, /协议 Word 版归入投资实施/);
  assert.match(userPrompt, /【文件夹名】/);
});

test('没有备注时提示词里不出现口径这一节', () => {
  const userPrompt = String(
    buildStageDecisionPrompt({ sourcePath: 'a.pdf', facts: facts() })[1].content
  );
  assert.equal(userPrompt.includes('本项目的归档口径'), false);
});
