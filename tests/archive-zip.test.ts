import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildZipEntryPaths,
  longestCommonPrefix,
  buildZipFileName,
} from '../src/lib/archive-zip';

/**
 * 打包下载的目录结构。
 *
 * 需求只有一句："下载之后也保留网页上已归档的文件树结构"，但三个入口对"根目录是哪一层"
 * 的期望不一样：整项目从项目名开始，单个文件夹从那个文件夹开始，跨层级勾选又得退回项目
 * 名——否则两个分支的文件砍掉公共前缀后会挤在同一层，看不出原来分属哪个阶段。
 */

const file = (id: string, folderPath: string[], archivedName: string) => ({
  id,
  folderPath,
  archivedName,
});

test('整个项目：根目录是项目名，阶段和子文件夹层级原样保留', () => {
  const entries = buildZipEntryPaths([
    file('a', ['佰特微', '2-尽职调查'], '法律尽调报告.pdf'),
    file('b', ['佰特微', '3-投资决策', '上会材料'], '上会申请表.pdf'),
  ]);

  assert.equal(entries.get('a'), '佰特微/2-尽职调查/法律尽调报告.pdf');
  assert.equal(entries.get('b'), '佰特微/3-投资决策/上会材料/上会申请表.pdf');
});

test('单个文件夹：basePath 指定的那一层成为包的根目录', () => {
  const entries = buildZipEntryPaths(
    [
      file('a', ['佰特微', '3-投资决策', '上会材料'], '营业执照.pdf'),
      file('b', ['佰特微', '3-投资决策', '上会材料', '财务'], '审计报告.pdf'),
    ],
    { basePath: ['佰特微', '3-投资决策', '上会材料'] }
  );

  assert.equal(entries.get('a'), '上会材料/营业执照.pdf');
  assert.equal(entries.get('b'), '上会材料/财务/审计报告.pdf');
});

test('文件夹里只有一个子文件夹时也不会把用户点的那层弄丢', () => {
  // 公共前缀会一路算到子文件夹，砍到那里的话解压出来是"财务/"，用户点的"上会材料"没了。
  const paths = [['佰特微', '3-投资决策', '上会材料', '财务']];
  assert.deepEqual(longestCommonPrefix(paths), [
    '佰特微',
    '3-投资决策',
    '上会材料',
    '财务',
  ]);

  const entries = buildZipEntryPaths(
    [file('a', paths[0], '审计报告.pdf')],
    { basePath: ['佰特微', '3-投资决策', '上会材料'] }
  );
  assert.equal(entries.get('a'), '上会材料/财务/审计报告.pdf');
});

test('跨层级勾选：分属不同阶段的文件保留各自完整路径', () => {
  const entries = buildZipEntryPaths([
    file('a', ['佰特微', '1-项目立项'], '立项报告.pdf'),
    file('b', ['佰特微', '2-尽职调查', '法律'], '法律尽调报告.pdf'),
  ]);

  assert.equal(entries.get('a'), '佰特微/1-项目立项/立项报告.pdf');
  assert.equal(entries.get('b'), '佰特微/2-尽职调查/法律/法律尽调报告.pdf');
});

test('basePath 不能覆盖全部选中文件时忽略它，退回公共前缀', () => {
  // 界面上不会这么传，但接口是公开的：如果照着 basePath 砍，不在它下面的文件会被砍出
  // 一条错误的相对路径（甚至砍掉自己的文件名所在层）。
  const entries = buildZipEntryPaths(
    [
      file('a', ['佰特微', '2-尽职调查'], '法律尽调报告.pdf'),
      file('b', ['佰特微', '1-项目立项'], '立项报告.pdf'),
    ],
    { basePath: ['佰特微', '2-尽职调查'] }
  );

  assert.equal(entries.get('a'), '佰特微/2-尽职调查/法律尽调报告.pdf');
  assert.equal(entries.get('b'), '佰特微/1-项目立项/立项报告.pdf');
});

test('砍掉前缀后撞在同一层的重名文件会加序号，不互相覆盖', () => {
  const entries = buildZipEntryPaths(
    [
      file('a', ['佰特微', '2-尽职调查'], '报告.pdf'),
      file('b', ['佰特微', '2-尽职调查'], '报告.pdf'),
    ],
    { basePath: ['佰特微', '2-尽职调查'] }
  );

  assert.equal(entries.get('a'), '2-尽职调查/报告.pdf');
  assert.equal(entries.get('b'), '2-尽职调查/报告(2).pdf');
  assert.equal(new Set([...entries.values()]).size, 2);
});

test('路径里的非法字符被替换，不会造出多余层级', () => {
  const entries = buildZipEntryPaths([
    file('a', ['项目/A', '阶段:一'], '报告*最终?.pdf'),
    file('b', ['项目/A', '阶段:二'], '立项报告.pdf'),
  ]);

  // 名字里的 "/" 必须换掉，否则解压时会被当成又一层目录。
  assert.equal(entries.get('a'), '项目-A/阶段-一/报告-最终-.pdf');
  assert.equal(entries.get('b'), '项目-A/阶段-二/立项报告.pdf');
});

test('压缩包文件名带日期且不含路径分隔符', () => {
  const name = buildZipFileName('佰特微/档案-归档文件');
  assert.match(name, /^佰特微-档案-归档文件-\d{4}-\d{2}-\d{2}\.zip$/);
});

test('没有文件时返回空映射，调用方据此报错而不是打个空包', () => {
  assert.equal(buildZipEntryPaths([]).size, 0);
});
