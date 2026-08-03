import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { SYSTEM_ARCHIVE_FOLDERS } from "../src/lib/folder-structure";

const projectRoot = process.cwd();

function readJson(relativePath: string) {
  return JSON.parse(
    readFileSync(path.join(projectRoot, relativePath), "utf8")
  ) as Record<string, unknown>;
}

test("君柔文件清单完整且重复组稳定", () => {
  const inventory = readJson("tests/fixtures/junrou-inventory.json") as {
    summary: {
      businessFileCount: number;
      duplicateGroupCount: number;
      stageCounts: Record<string, number>;
    };
    duplicateGroups: Array<{ id: string; paths: string[] }>;
    files: Array<{
      relativePath: string;
      sha256: string;
      duplicateGroup: string | null;
    }>;
  };

  assert.equal(inventory.summary.businessFileCount, 35);
  assert.equal(inventory.summary.duplicateGroupCount, 2);
  assert.deepEqual(inventory.summary.stageCounts, {
    立项前: 2,
    项目立项: 5,
    尽职调查: 2,
    投资决策: 13,
    投资实施: 12,
    未归类: 1,
  });

  const knownPaths = new Set(inventory.files.map(file => file.relativePath));
  for (const file of inventory.files) {
    assert.equal(file.sha256.length, 64);
    assert.equal(
      existsSync(path.join(projectRoot, "君柔档案", file.relativePath)),
      true,
      `原始文件不存在: ${file.relativePath}`
    );
  }

  for (const group of inventory.duplicateGroups) {
    assert.equal(group.paths.length, 2);
    for (const relativePath of group.paths) {
      assert.equal(knownPaths.has(relativePath), true);
      const record = inventory.files.find(
        file => file.relativePath === relativePath
      );
      assert.equal(record?.duplicateGroup, group.id);
    }
  }
});

test("君柔已验收金标准引用真实文件和现有分类", () => {
  const inventory = readJson("tests/fixtures/junrou-inventory.json") as {
    files: Array<{ relativePath: string }>;
  };
  const fixture = readJson(
    "tests/fixtures/junrou-classification-cases.json"
  ) as {
    status: string;
    approvalSource: string;
    cases: Array<{
      id: string;
      relativePath: string;
      expectedFolder: {
        folderId: string;
      } | null;
      relatedFiles: string[];
    }>;
  };

  const knownPaths = new Set(inventory.files.map(file => file.relativePath));
  assert.equal(fixture.status, "pilot_gold_set_approved");
  assert.equal(fixture.approvalSource, "user_domain_review");
  assert.equal(fixture.cases.length, 6);

  for (const classificationCase of fixture.cases) {
    assert.equal(
      knownPaths.has(classificationCase.relativePath),
      true,
      `评测文件不在清单中: ${classificationCase.id}`
    );
    for (const relatedPath of classificationCase.relatedFiles) {
      assert.equal(
        knownPaths.has(relatedPath),
        true,
        `关联文件不在清单中: ${classificationCase.id} -> ${relatedPath}`
      );
    }

    if (!classificationCase.expectedFolder) continue;
    assert.equal(
      SYSTEM_ARCHIVE_FOLDERS.some(
        folder => folder.folderId === classificationCase.expectedFolder?.folderId
      ),
      true,
      `文件夹树中不存在预期阶段: ${classificationCase.id}`
    );
  }
});

test("君柔项目时间线按日期排序并只保留未解决问题", () => {
  const context = readJson("tests/fixtures/junrou-project-context.json") as {
    contextStatus: string;
    timeline: Array<{
      date: string;
      evidenceFiles: string[];
    }>;
    openQuestions: string[];
  };

  const sortedDates = context.timeline.map(event => event.date).sort();
  assert.deepEqual(
    context.timeline.map(event => event.date),
    sortedDates
  );
  assert.equal(context.contextStatus, "gold_labels_approved_context_draft");
  assert.equal(context.timeline.length, 7);
  assert.equal(context.openQuestions.length, 2);
});
