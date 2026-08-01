import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const archiveRoot = path.join(projectRoot, "君柔档案");
const outputPath = path.join(
  projectRoot,
  "tests",
  "fixtures",
  "junrou-inventory.json"
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async entry => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath);
      if (!entry.isFile() || entry.name === ".DS_Store") return [];
      return [fullPath];
    })
  );
  return nested.flat();
}

function stageFromRelativePath(relativePath) {
  const [firstSegment] = relativePath.split(path.sep);
  const knownStages = new Set([
    "立项前",
    "项目立项",
    "尽职调查",
    "投资决策",
    "投资实施",
  ]);
  return knownStages.has(firstSegment) ? firstSegment : "未归类";
}

const sourceFiles = (await listFiles(archiveRoot)).sort((a, b) =>
  a.localeCompare(b, "zh-CN")
);

const fileRecords = await Promise.all(
  sourceFiles.map(async sourcePath => {
    const relativePath = path.relative(archiveRoot, sourcePath);
    const fileStat = await stat(sourcePath);
    const content = await readFile(sourcePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const extension = path.extname(sourcePath).slice(1).toLowerCase();
    const initialStageLabel = stageFromRelativePath(relativePath);
    const fileName = path.basename(sourcePath);
    const ambiguityReasons = [];

    if (initialStageLabel === "未归类") {
      ambiguityReasons.push("文件位于项目档案根目录，缺少阶段目录标签");
    }
    if (fileName.includes("章程")) {
      ambiguityReasons.push("公司章程可能在多个投资阶段出现，需要结合交易前后事实消歧");
    }

    return {
      relativePath: relativePath.split(path.sep).join("/"),
      fileName,
      extension,
      sizeBytes: fileStat.size,
      sha256,
      initialStageLabel,
      labelSource: initialStageLabel === "未归类" ? "none" : "directory",
      ambiguityReasons,
      duplicateGroup: null,
    };
  })
);

const filesByHash = new Map();
for (const file of fileRecords) {
  const group = filesByHash.get(file.sha256) ?? [];
  group.push(file);
  filesByHash.set(file.sha256, group);
}

const duplicateGroups = [];
let duplicateIndex = 1;
for (const [sha256, files] of filesByHash) {
  if (files.length < 2) continue;
  const id = `duplicate-${String(duplicateIndex).padStart(3, "0")}`;
  duplicateIndex += 1;
  for (const file of files) {
    file.duplicateGroup = id;
    file.ambiguityReasons.push("与同项目中的另一文件内容完全相同");
  }
  duplicateGroups.push({
    id,
    sha256,
    paths: files.map(file => file.relativePath),
  });
}

const stageCounts = {};
const formatCounts = {};
for (const file of fileRecords) {
  stageCounts[file.initialStageLabel] =
    (stageCounts[file.initialStageLabel] ?? 0) + 1;
  formatCounts[file.extension] = (formatCounts[file.extension] ?? 0) + 1;
}

const inventory = {
  schemaVersion: 1,
  projectName: "君柔",
  sourceDirectory: "君柔档案",
  labelPolicy:
    "目录名仅作为初始弱标签；在人工确认和内容证据核验前，不视为最终金标准。",
  summary: {
    businessFileCount: fileRecords.length,
    totalSizeBytes: fileRecords.reduce((sum, file) => sum + file.sizeBytes, 0),
    stageCounts,
    formatCounts,
    duplicateGroupCount: duplicateGroups.length,
  },
  duplicateGroups,
  files: fileRecords,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
console.log(`Wrote ${fileRecords.length} records to ${outputPath}`);
