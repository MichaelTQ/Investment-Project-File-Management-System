import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SUB_PATH_DEPTH,
  parseSourceLocation,
  sanitizeSubPath,
} from '../src/lib/archive-subpath';

test('判断只发生在顶层，顶层之下的层级原样保留', () => {
  const parsed = parseSourceLocation(
    '佰特微档案/投资决策/1、天士力FA财务尽调资料2025.7/7、银行对账单/招行2025年06月.pdf'
  );
  // 第一段是用户拖进来的根目录，本身不参与判断
  assert.equal(parsed.topLevelName, '投资决策');
  assert.deepEqual(parsed.innerPath, [
    '1、天士力FA财务尽调资料2025.7',
    '7、银行对账单',
  ]);
  assert.equal(parsed.isTopLevelFile, false);
});

test('顶层散文件走现有链路，没有子路径', () => {
  const parsed = parseSourceLocation('佰特微档案/尽调报告.pdf');
  assert.equal(parsed.topLevelName, '尽调报告.pdf');
  assert.deepEqual(parsed.innerPath, []);
  assert.equal(parsed.isTopLevelFile, true);
});

test('顶层文件夹里直接放文件时没有更深层级', () => {
  const parsed = parseSourceLocation('佰特微档案/投资实施/1、投资合同书.pdf');
  assert.equal(parsed.topLevelName, '投资实施');
  assert.deepEqual(parsed.innerPath, []);
  assert.equal(parsed.isTopLevelFile, false);
});

test('多选文件（没有目录）不会被当成顶层文件夹', () => {
  const parsed = parseSourceLocation('君柔投委会决议.pdf');
  assert.equal(parsed.topLevelName, '君柔投委会决议.pdf');
  assert.equal(parsed.isTopLevelFile, true);
});

test('剔除会跳出目标目录的段', () => {
  assert.deepEqual(sanitizeSubPath('a/../b'), ['a', 'b']);
  assert.deepEqual(sanitizeSubPath('./a'), ['a']);
  assert.deepEqual(sanitizeSubPath(['..', '..', '尽调']), ['尽调']);
});

test('空段和非字符串被丢掉，不产生空目录', () => {
  assert.deepEqual(sanitizeSubPath('a//b/'), ['a', 'b']);
  assert.deepEqual(sanitizeSubPath(['a', '', '   ', 42, null, 'b']), ['a', 'b']);
  assert.deepEqual(sanitizeSubPath(undefined), []);
});

test('空格和连字符必须放行，真实目录名到处都是', () => {
  assert.deepEqual(
    sanitizeSubPath('国创中山基金投资文件V4_清洁版_2026.06/佰特微-投后 备份'),
    ['国创中山基金投资文件V4_清洁版_2026.06', '佰特微-投后 备份']
  );
});

test('层数超过上限就截断，不无限深', () => {
  const deep = Array.from({ length: 20 }, (_, i) => `l${i}`);
  assert.equal(sanitizeSubPath(deep).length, MAX_SUB_PATH_DEPTH);
});

test('单段过长会截短，不会撑爆对象键', () => {
  const [segment] = sanitizeSubPath('长'.repeat(500));
  assert.equal(segment.length, 100);
});
