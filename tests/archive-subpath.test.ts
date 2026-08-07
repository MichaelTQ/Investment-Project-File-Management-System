import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SUB_PATH_DEPTH,
  parseSourceLocation,
  sanitizeSubPath,
} from '../src/lib/archive-subpath';
import {
  ALL_ARCHIVE_FOLDERS,
  resolveArchiveFolder,
  SYSTEM_ARCHIVE_FOLDERS,
} from '../src/lib/folder-structure';

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

/* 分组层现在也是合法归档目标（用户 2026-08-07 决定），代价是这些文件没有业务阶段，
   不进时间线和冲突复核。解析必须最长前缀优先，否则一切都会落到根目录上。 */

test('最长前缀优先：选到阶段之下的层，仍解析为那个阶段', () => {
  const resolved = resolveArchiveFolder([
    '投资项目档案',
    '基金投资及投资执行',
    '投资决策',
    '1、天士力FA财务尽调资料2025.7',
  ]);
  assert.equal(resolved?.folder.businessStage, 'investment_decision');
  assert.deepEqual(resolved?.subPath, ['1、天士力FA财务尽调资料2025.7']);
});

test('分组层可以作为归档目标，但没有业务阶段', () => {
  const grouping = resolveArchiveFolder(['投资项目档案', '基金投资及投资执行']);
  assert.equal(grouping?.folder.name, '基金投资及投资执行');
  assert.equal(grouping?.folder.businessStage, null);
  assert.deepEqual(grouping?.subPath, []);

  const root = resolveArchiveFolder(['投资项目档案']);
  assert.equal(root?.folder.businessStage, null);
});

test('阶段选择器只拿得到八个阶段，分组层不混进去', () => {
  assert.equal(SYSTEM_ARCHIVE_FOLDERS.length, 8);
  for (const folder of SYSTEM_ARCHIVE_FOLDERS) {
    assert.notEqual(folder.businessStage, null);
  }
  // 但全量列表里必须有分组层，否则归档接口会拒掉它们
  assert.ok(ALL_ARCHIVE_FOLDERS.length > SYSTEM_ARCHIVE_FOLDERS.length);
});

test('路径对不上任何目录时返回 null', () => {
  assert.equal(resolveArchiveFolder(['不存在的目录']), null);
});
