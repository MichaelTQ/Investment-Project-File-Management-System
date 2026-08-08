import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/**
 * 树形缩进的实现约束。
 *
 * 缩进曾经用 `style={{ paddingLeft }}` 加在行容器上，而同一个 className 里还有
 * `px-2`——Tailwind v4 把它编译成 padding-inline 这类逻辑属性，和物理的 padding-left
 * 写的是同一条边，行为不好预料。改成在行首插一个定宽占位元素，布局元素不受任何
 * padding 或逻辑属性影响，横向滚动时也不会被压掉。
 *
 * 但改法本身有个坑：五个树组件的行结构长得很像，用文本锚点批量插入时**又插重了
 * 又插漏了**——FolderTree 插了两个（缩进翻倍），MoveFolderNode 一个没插（完全没有
 * 缩进，表现为"所有层级平铺、看起来往左偏"）。这条测试就是防这个。
 */
const source = fs.readFileSync('src/app/page.tsx', 'utf8');

/**
 * 组件 → 它渲染出几种行。
 *
 * ArchiveTreeItem 是 2：文件节点提前 return 一种行，文件夹节点走到后面另一种行，
 * 两种都要缩进。其余组件各只渲染一种行。
 */
const TREE_ROW_COMPONENTS: Array<[string, number]> = [
  ['FolderTree', 1],
  ['MoveFolderNode', 1],
  ['ArchiveTreeItem', 2],
  ['BatchTreeItem', 1],
  ['BatchFileRow', 1],
];

/** 取出某个顶层函数的源码。 */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `找不到组件 ${name}`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\nfunction ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('每种树行都有且只有一个缩进占位元素', () => {
  for (const [name, expected] of TREE_ROW_COMPONENTS) {
    const body = functionBody(name);
    const count = body.split('aria-hidden className="shrink-0"').length - 1;
    assert.equal(
      count,
      expected,
      `${name} 里有 ${count} 个缩进占位元素，应为 ${expected} 个。` +
        '少了等于那种行完全没有缩进，多了等于缩进翻倍。'
    );
  }
});

test('缩进随层级递增，方向朝右', () => {
  for (const [name] of TREE_ROW_COMPONENTS) {
    const body = functionBody(name);
    // 宽度必须是 level 的正比例，写成常量或负数都会让缩进失效
    assert.match(
      body,
      /width: `\$\{level \* \d+\}px`/,
      `${name} 的占位宽度不是 level 的正比例`
    );
  }
});

test('行容器上不再残留 paddingLeft，避免与 px-* 抢同一条边', () => {
  assert.equal(
    source.includes('paddingLeft'),
    false,
    '又出现了 paddingLeft，会和 className 里的 px-* 冲突'
  );
});
