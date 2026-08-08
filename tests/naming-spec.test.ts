import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTermIndex,
  listAmbiguousTerms,
  matchSpecTerm,
  NAMING_SPEC,
  SPEC_TERMS,
} from '../src/lib/classification/naming-spec';
import {
  buildFilenameNormalizePrompt,
  parseFilenameNormalizeResponse,
} from '../src/lib/classification/filename-normalizer';

test('歧义是数出来的，不是手写的', () => {
  // 造一份假规范：同一个词条挂在两个阶段下。
  const index = buildTermIndex([
    { stage: 'initiation', label: '甲', terms: ['某报告', '独有条目'] },
    { stage: 'due_diligence', label: '乙', terms: ['某报告'] },
  ]);
  assert.deepEqual(index.get('某报告'), ['initiation', 'due_diligence']);
  assert.deepEqual(index.get('独有条目'), ['initiation']);
});

test('规范里跨阶段的词条全部判为歧义', () => {
  const ambiguous = new Map(
    listAmbiguousTerms().map(entry => [entry.term, entry.stages])
  );

  // 这八条来自客户规范原文，逐行核对过。少了任何一条都说明规范表被改坏了。
  assert.deepEqual(ambiguous.get('立项评审纪要'), [
    'initiation',
    'investment_decision',
  ]);
  assert.deepEqual(ambiguous.get('公司章程'), [
    'investment_decision',
    'investment_execution',
  ]);
  assert.deepEqual(ambiguous.get('表决票'), [
    'investment_decision',
    'exit_decision',
  ]);
  assert.deepEqual(ambiguous.get('投委会决议'), [
    'investment_decision',
    'exit_decision',
  ]);
  assert.deepEqual(ambiguous.get('转账凭证'), [
    'investment_execution',
    'exit_execution',
  ]);
  assert.deepEqual(ambiguous.get('审计报告'), [
    'investment_decision',
    'post_investment',
  ]);
  assert.deepEqual(ambiguous.get('财务尽职调查报告'), [
    'due_diligence',
    'investment_decision',
  ]);
  assert.deepEqual(ambiguous.get('法律尽职调查报告'), [
    'due_diligence',
    'investment_decision',
  ]);
  assert.equal(ambiguous.size, 8);
});

test('唯一命中的词条给出单一阶段', () => {
  const matched = matchSpecTerm('增资协议');
  assert.equal(matched.kind, 'unique');
  assert.deepEqual(matched.stages, ['investment_execution']);
});

test('歧义词条给出多个候选，不下结论', () => {
  const matched = matchSpecTerm('公司章程');
  assert.equal(matched.kind, 'ambiguous');
  assert.equal(matched.stages.length, 2);
});

test('清单以外的词按没匹配上处理，绝不猜', () => {
  // 模型幻觉出一个不存在的词条时，必须退化成"未命中"而不是硬塞一个阶段。
  for (const value of ['信用报告', '科目余额表', '', null, undefined]) {
    const matched = matchSpecTerm(value);
    assert.equal(matched.kind, 'unmatched');
    assert.equal(matched.term, null);
    assert.deepEqual(matched.stages, []);
  }
});

test('业务尽调报告只在尽职调查出现，因此是唯一命中', () => {
  // 规范的投资决策上会材料只列了法务和财务尽调，没有业务尽调——这个差别是从
  // 规范原文数出来的，不是拍的。
  assert.equal(matchSpecTerm('业务尽职调查报告').kind, 'unique');
  assert.equal(matchSpecTerm('财务尽职调查报告').kind, 'ambiguous');
});

test('归一化提示词只给词条，不出现任何阶段名', () => {
  const systemPrompt = String(buildFilenameNormalizePrompt(['a.pdf'])[0].content);
  assert.match(systemPrompt, /只能输出上面清单里的词条原文/);
  assert.match(systemPrompt, /对不上就答"无"/);
  // 阶段枚举绝不能进这个提示词：一旦模型看到阶段，就会绕过词条直接判阶段。
  for (const section of NAMING_SPEC) {
    assert.equal(systemPrompt.includes(section.stage), false);
  }
});

test('归一化按序号回填，多打少打都不会让后面集体错位', () => {
  const terms = parseFilenameNormalizeResponse(
    ['1:增资协议', '这一行是模型多嘴的说明', '3:公司章程'].join('\n'),
    3
  );
  assert.deepEqual(terms, ['增资协议', null, '公司章程']);
});

test('归一化丢弃清单以外的词和"无"', () => {
  const terms = parseFilenameNormalizeResponse(
    ['1:无', '2:信用报告', '3:《股东协议》'].join('\n'),
    3
  );
  assert.deepEqual(terms, [null, null, '股东协议']);
});

test('归一化忽略越界序号，不会写脏数组', () => {
  const terms = parseFilenameNormalizeResponse('9:增资协议\n1:股东名册', 2);
  assert.deepEqual(terms, ['股东名册', null]);
});

test('词条清单去重后仍覆盖全部阶段的条目', () => {
  const flattened = new Set(NAMING_SPEC.flatMap(section => section.terms));
  assert.equal(SPEC_TERMS.length, flattened.size);
  for (const term of flattened) assert.ok(SPEC_TERMS.includes(term));
});
