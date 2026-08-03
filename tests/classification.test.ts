import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfidence } from '../src/lib/classification';
import { inferBusinessStage } from '../src/lib/classification/business-stage';
import {
  SYSTEM_ARCHIVE_FOLDERS,
  getArchiveFolder,
  getFolderForBusinessStage,
} from '../src/lib/folder-structure';

test('系统只暴露八个业务阶段归档文件夹', () => {
  assert.equal(SYSTEM_ARCHIVE_FOLDERS.length, 8);
  assert.deepEqual(
    SYSTEM_ARCHIVE_FOLDERS.map(folder => folder.name),
    ['立项前', '项目立项', '尽职调查', '投资决策', '投资实施', '投后管理', '退出决策', '退出执行']
  );
});

test('业务阶段与最终文件夹一一对应', () => {
  const folder = getFolderForBusinessStage('initiation');
  assert.equal(folder.folderId, 'project-initiation');
  assert.deepEqual(folder.folderPath, ['投资项目档案', '基金投资及投资执行', '项目立项']);
});

test('立项表决结果由阶段证据归入项目立项，不再匹配细分类别', () => {
  const decision = inferBusinessStage({
    sourcePath: '佰特微立项表决结果.pdf',
    text: '项目立项评审 表决结果 同意立项',
  });
  assert.equal(decision.selectedStage, 'initiation');
  assert.equal(
    getFolderForBusinessStage(decision.selectedStage!).folderId,
    'project-initiation'
  );
});

test('投委会表决归入投资决策阶段', () => {
  const decision = inferBusinessStage({
    sourcePath: '投资决策委员会表决结果.pdf',
    text: '投资决策委员会审议并通过本次投资方案',
  });
  assert.equal(decision.selectedStage, 'investment_decision');
});

test('文件夹查询不会返回不存在的细分类别', () => {
  assert.equal(getArchiveFolder('decision-meeting'), null);
  assert.equal(getArchiveFolder('investment-decision')?.name, '投资决策');
});

test('置信度会校验并限制在 0 到 100', () => {
  assert.equal(normalizeConfidence(0), 0);
  assert.equal(normalizeConfidence('81.6'), 82);
  assert.equal(normalizeConfidence(120), 100);
  assert.equal(normalizeConfidence(-5), 0);
  assert.equal(normalizeConfidence('invalid'), 0);
});
