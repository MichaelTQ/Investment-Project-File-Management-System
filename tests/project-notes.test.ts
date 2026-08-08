import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeProjectNotes,
  MAX_PROJECT_NOTES_LENGTH,
  normalizeProjectNotes,
} from '../src/lib/classification/project-notes';
import {
  buildBatchStageDecisionPrompt,
  buildStageDecisionPrompt,
} from '../src/lib/classification/llm-stage-decision';
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

/* 各方身份：阶段定义本身分不开"同一份材料的不同来源"，实测《天士力FA财务尽调资料》
   反复被判到尽职调查。区分点是"谁出的、给谁用的"，而各方身份只有项目负责人知道。 */

test('三个判阶段的提示词都带上了各方身份说明', () => {
  const single = String(
    buildStageDecisionPrompt({ sourcePath: 'a.pdf', facts: facts() })[0].content
  );
  const batch = String(
    buildBatchStageDecisionPrompt({
      items: [{ sourcePath: 'a.pdf', facts: facts() }],
    })[0].content
  );
  const folder = String(buildFolderStagePrompt(['某文件夹'])[0].content);

  for (const prompt of [single, batch, folder]) {
    assert.match(prompt, /谁出的、给谁用的/);
    assert.match(prompt, /口径没有写明的身份不要臆测/);
  }
  // 但不许出现任何"某类文件属于某阶段"的映射
  for (const prompt of [single, batch, folder]) {
    assert.equal(prompt.includes('财务尽调底稿归'), false);
    assert.equal(prompt.includes('FA 提供的'), false);
  }
});

test('口径块讲清各方身份，而不只是归档习惯', () => {
  const block = describeProjectNotes('天士力担任 FA');
  assert.match(block, /各方身份/);
  assert.match(block, /按口径说明的角色去理解，不要只当成一个陌生的名字/);
});

test('判文件夹时去掉"以文件内容为准"，那句在这里没有依据可依', () => {
  const forFolder = describeProjectNotes('天士力担任 FA', { hasFileContent: false });
  // 文件夹判阶段读不到内容，留着这句等于给模型一个不采信口径的台阶
  assert.equal(forFolder.includes('仍按内容判断'), false);
  assert.match(forFolder, /这份口径是你手上最硬的依据/);

  const forFile = describeProjectNotes('天士力担任 FA');
  assert.match(forFile, /仍按内容判断/);
});

test('文件夹提示词的第一条不再把口径排除在外', () => {
  const systemPrompt = String(buildFolderStagePrompt(['某文件夹'])[0].content);
  // 旧措辞"只看文件夹名字本身"字面上就是叫模型别看口径
  assert.equal(systemPrompt.includes('只看文件夹名字本身'), false);
  assert.match(systemPrompt, /加上下面给出的归档口径/);
  assert.match(systemPrompt, /口径里写明的各方身份和归档习惯必须用上/);
});

test('整批那份候选提示与单份一致，不再允许另挑阶段', () => {
  const batch = String(
    buildBatchStageDecisionPrompt({
      items: [
        {
          sourcePath: '章程.pdf',
          facts: facts(),
          namingHint: {
            term: '公司章程',
            stages: ['investment_decision', 'investment_execution'],
          },
        },
      ],
    })[1].content
  );
  assert.match(batch, /请从这几个候选里选一个/);
  assert.match(batch, /不要在候选之外自己另挑一个阶段/);
  // 旧措辞会让模型走出候选，实测章程就是这样跑到尽职调查去的
  assert.equal(batch.includes('文件内容指向别的阶段时就选别的阶段'), false);
});
