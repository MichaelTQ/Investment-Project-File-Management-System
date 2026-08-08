import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFolderStagePrompt,
  matchStageByFolderName,
  parseFolderStageResponse,
  STAGE_FOLDER_NAMES,
} from '../src/lib/classification/folder-stage';

test('文件夹名精确等于阶段名时直接命中，不需要模型', () => {
  // 佰特微顶层的 5 个目录都是这种情况，判断成本为零。
  assert.equal(matchStageByFolderName('投资决策'), 'investment_decision');
  assert.equal(matchStageByFolderName('尽职调查'), 'due_diligence');
  assert.equal(matchStageByFolderName('立项前'), 'pre_initiation');
  assert.equal(matchStageByFolderName('  投资实施  '), 'investment_execution');
});

test('名字对不上阶段就交给模型，不做模糊匹配', () => {
  // "协议word版本" 是按文件格式起的名，含糊；"投资决策资料" 多了两个字也不算命中。
  assert.equal(matchStageByFolderName('协议word版本'), null);
  assert.equal(matchStageByFolderName('投资决策资料'), null);
  assert.equal(matchStageByFolderName('1、天士力FA财务尽调资料2025.7'), null);
});

test('八个阶段名一个不少', () => {
  assert.equal(STAGE_FOLDER_NAMES.length, 8);
  for (const name of ['立项前', '项目立项', '尽职调查', '投资决策', '投资实施', '投后管理', '退出决策', '退出执行']) {
    assert.ok(STAGE_FOLDER_NAMES.includes(name), `缺少阶段 ${name}`);
  }
});

test('解析按序号回填，漏一条不会让后面集体错位', () => {
  const stages = parseFolderStageResponse('3:投资实施\n1:投资决策', 3);
  assert.equal(stages[0], 'investment_decision');
  // 第 2 个模型没给，必须留 null 进「未能区分」，不能错位成第 3 个的结果
  assert.equal(stages[1], null);
  assert.equal(stages[2], 'investment_execution');
});

test('"无"和清单外的说法都判为未能区分，绝不猜', () => {
  const stages = parseFolderStageResponse(
    '1:无\n2:投后阶段\n3:investment_decision\n4:「投资决策」',
    4
  );
  assert.equal(stages[0], null);
  // "投后阶段" 不是清单里的写法
  assert.equal(stages[1], null);
  // 英文枚举值也不接受，提示词明确要求中文名
  assert.equal(stages[2], null);
  // 书名号会被剥掉
  assert.equal(stages[3], 'investment_decision');
});

test('提示词要求含糊的名字必须答无', () => {
  const systemPrompt = String(buildFolderStagePrompt(['协议word版本'])[0].content);
  // 措辞从「只看文件夹名字本身」改掉了——那句字面上会把归档口径一起排除。
  assert.match(systemPrompt, /不要臆测文件夹里装了什么文件/);
  assert.match(systemPrompt, /输出"无"是正确结果，不是失败/);
  assert.match(systemPrompt, /不要为了给每一个都填上答案而勉强选一个最接近的/);
});
