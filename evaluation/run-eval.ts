/**
 * 离线评测：复刻前端批量分流的真实链路，在有模型凭证的环境里跑。
 *
 * 链路与 app/page.tsx 的 runBatchFlow 一一对应（4724-5300 行）：
 *
 *   第0步  带子目录的文件 → 按顶层文件夹名整组定阶段（/api/folders 的逻辑）
 *          文件夹里的文件一份都不读。这是整条流程省时间的全部来源。
 *   ①      散在根目录的文件 → 整批一次文件名归一（/api/naming）
 *   ②      归一后 unique 的 → 短路：直接定阶段，不读内容、不 OCR
 *   ③      其余 → 逐份上传 + 读内容（PDF 抽文本 / 扫描件与图片走 OCR）+ 抽事实
 *          **先把整批的事实全抽完**，此时不判阶段
 *   ④      整批一次判阶段（/api/decide → decideStagesForBatchWithModel）
 *          模型同时看到全部文件的事实，横向比对后一次给出所有结论
 *   ⑤      整批漏判的那几份，退回逐份判（前端的兜底分支）
 *
 * 两条硬规矩：
 * - 进模型的一律只有 leafName()，不含目录。目录名就是标准答案，喂进去等于泄题。
 *   例外是第0步——它按设计就是看文件夹名的，那是线上真实行为，不是泄题。
 * - 调的是 src/ 下线上那几个模块本身，不是替代实现。
 *
 * 已知与线上的偏差（报告里会打印，别当成等价）：
 * - archivedDocuments（项目档案库里已归档文件的事实）为空。评测从空档案开始。
 * - projectNotes（项目负责人填的归档口径）为空。
 * - timeline（项目事件时间线）为空。
 * - 不跑 /api/deepen。它是人工触发的旁路，且只取证不判阶段，另行评测。
 */
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, sep } from 'node:path';

import { leafName } from '../src/lib/classification/source-path';
import { normalizeFilenamesWithModel } from '../src/lib/classification/filename-normalizer';
import { matchSpecTerm } from '../src/lib/classification/naming-spec';
import {
  matchStageByFolderName,
  classifyFoldersWithModel,
} from '../src/lib/classification/folder-stage';
import { readDocumentContent, getMimeType } from '../src/lib/classification/read-document-content';
import { extractDocumentFacts } from '../src/lib/classification/fact-extractor';
import {
  decideStagesForBatchWithModel,
  decideStageWithModel,
  type BatchStageDecisionItem,
} from '../src/lib/classification/llm-stage-decision';
import type { DocumentFacts } from '../src/lib/classification/document-facts';
import type { ArchiveBusinessStage } from '../src/lib/folder-structure';
import { uploadTempFileFromBuffer } from '../src/lib/storage';

const ROOT = join(import.meta.dirname, '..');
/** 评测用的临时上传目录，与真实项目分开。 */
const EVAL_PROJECT_ID = 'eval-run';

const STAGE_BY_LABEL: Record<string, ArchiveBusinessStage> = {
  立项前: 'pre_initiation',
  项目立项: 'initiation',
  尽职调查: 'due_diligence',
  投资决策: 'investment_decision',
  投资实施: 'investment_execution',
};
const LABEL_BY_STAGE = Object.fromEntries(
  Object.entries(STAGE_BY_LABEL).map(([k, v]) => [v, k])
) as Record<string, string>;

const PROJECT_DIR: Record<string, string> = { 君柔: '君柔档案', 佰特微: '佰特微档案' };

interface Answer { project: string; file: string; answer: string; set: string }

type Path = 'folder_rule' | 'naming_rule' | 'batch_decide' | 'single_decide' | 'error';

interface Row {
  project: string;
  file: string;
  expected: string;
  predicted: string | null;
  path: Path;
  namingKind: string;
  namingTerm: string | null;
  requiresHumanReview: boolean;
  reasoning: string;
  ms: number;
  contentChars?: number;
  error?: string;
}

/** 跑之前把会白烧一轮的前提全查掉。 */
function preflight(entries: Answer[]) {
  const problems: string[] = [];
  const baseUrl = process.env.COZE_INTEGRATION_MODEL_BASE_URL?.trim() ?? '';
  const apiKey = process.env.COZE_WORKLOAD_IDENTITY_API_KEY?.trim() ?? '';
  if (!baseUrl) problems.push('缺少 COZE_INTEGRATION_MODEL_BASE_URL');
  else if (!/^https?:\/\//.test(baseUrl))
    problems.push(`COZE_INTEGRATION_MODEL_BASE_URL 不是合法 URL（当前是 "${baseUrl}"）`);
  if (!apiKey) problems.push('缺少 COZE_WORKLOAD_IDENTITY_API_KEY');
  else if (apiKey === '...' || apiKey.length < 8)
    problems.push('COZE_WORKLOAD_IDENTITY_API_KEY 看起来是占位符');

  const missing: string[] = [];
  for (const project of [...new Set(entries.map(e => e.project))]) {
    const dir = join(ROOT, PROJECT_DIR[project]);
    if (!existsSync(dir)) {
      problems.push(`样本目录不存在：${PROJECT_DIR[project]}/`);
      continue;
    }
    for (const e of entries.filter(x => x.project === project))
      if (!existsSync(join(dir, e.file))) missing.push(`${PROJECT_DIR[project]}/${e.file}`);
  }
  if (missing.length)
    problems.push(
      `answers.json 里有 ${missing.length} 份文件在本机找不到，前几个：\n` +
        missing.slice(0, 5).map(f => `      ${f}`).join('\n')
    );

  mkdirSync(join(ROOT, 'evaluation/reports'), { recursive: true });
  if (problems.length) {
    console.error('\n跑不了，先解决这些：\n' + problems.map(p => `  ✗ ${p}`).join('\n') + '\n');
    process.exit(1);
  }
}

/** 中文按两格宽算，否则表格错位。 */
function pad(text: string, width: number): string {
  const w = [...text].reduce((a, c) => a + (/[⺀-￿]/.test(c) ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}
const percent = (n: number, d: number) => (d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const wantFinal = process.argv.includes('--final');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  const targetSet = wantFinal ? 'final' : 'dev';

  const answers: { entries: Answer[] } = JSON.parse(
    readFileSync(join(ROOT, 'evaluation/answers.json'), 'utf8')
  );
  const entries = answers.entries.filter(e => e.set === targetSet).slice(0, limit);
  if (!entries.length) {
    console.error(`answers.json 里没有 set=${targetSet} 的条目`);
    process.exit(1);
  }
  preflight(entries);

  const projects = [...new Set(entries.map(e => e.project))];
  console.log(
    `\n评测集 ${targetSet}：${projects.join('、')}，共 ${entries.length} 份` +
      (wantFinal ? '   ⚠️ 验收集' : '')
  );

  const rows: Row[] = [];
  for (const project of projects) {
    rows.push(...(await runProject(project, entries.filter(e => e.project === project))));
  }
  report(rows, targetSet);
}

async function runProject(project: string, items: Answer[]): Promise<Row[]> {
  const dir = join(ROOT, PROJECT_DIR[project]);
  const rows: Row[] = [];

  // ---------- 第0步：带子目录的文件按顶层文件夹名整组定阶段 ----------
  // 复刻前端：文件夹里的文件一份都不读，文件夹名就是判断依据。
  const inFolder = items.filter(e => e.file.includes(sep) || e.file.includes('/'));
  const loose = items.filter(e => !inFolder.includes(e));

  if (inFolder.length) {
    const folderNames = [...new Set(inFolder.map(e => e.file.split(/[/\\]/)[0]))];
    console.log(`\n[${project}] 第0步 文件夹分流：${folderNames.length} 个文件夹，覆盖 ${inFolder.length} 份文件`);

    const stageByFolder = new Map<string, ArchiveBusinessStage | null>();
    const pending: string[] = [];
    for (const name of folderNames) {
      const exact = matchStageByFolderName(name);
      stageByFolder.set(name, exact);
      if (!exact) pending.push(name);
    }
    if (pending.length) {
      const classified = await classifyFoldersWithModel({ folderNames: pending, customHeaders: {} });
      pending.forEach((name, i) => stageByFolder.set(name, classified.stages[i] ?? null));
    }
    for (const name of folderNames)
      console.log(`   ${name} → ${LABEL_BY_STAGE[stageByFolder.get(name) ?? ''] ?? '未能区分'}`);

    for (const e of inFolder) {
      const stage = stageByFolder.get(e.file.split(/[/\\]/)[0]) ?? null;
      rows.push({
        project, file: e.file, expected: e.answer,
        predicted: stage ? LABEL_BY_STAGE[stage] : null,
        path: 'folder_rule', namingKind: '-', namingTerm: null,
        requiresHumanReview: !stage,
        reasoning: '按顶层文件夹名整组归档，未读取文件内容',
        ms: 0,
      });
    }
  }

  if (!loose.length) return rows;

  // ---------- ① 整批文件名归一（只给 leafName） ----------
  console.log(`\n[${project}] ① 文件名归一 ${loose.length} 份…`);
  const leaves = loose.map(e => leafName(e.file));
  const normalized = await normalizeFilenamesWithModel({ sourcePaths: leaves, customHeaders: {} });
  if (normalized.status !== 'success') {
    console.error(
      `\n[${project}] 文件名归一失败，评测中止。\n` +
        '  线上会降级成"全部走事实链路"，但评测不能——短路那条路一份都测不到，\n' +
        '  出来的数字描述的不是线上链路。\n'
    );
    process.exit(1);
  }
  const matches = leaves.map((_, i) => matchSpecTerm(normalized.terms[i]));
  const counts = matches.reduce(
    (a, m) => ({ ...a, [m.kind]: a[m.kind] + 1 }),
    { unique: 0, ambiguous: 0, unmatched: 0 } as Record<string, number>
  );
  console.log(`   唯一命中 ${counts.unique}（短路） / 歧义 ${counts.ambiguous} / 未命中 ${counts.unmatched}`);

  // ---------- ② 唯一命中：短路，不读内容 ----------
  const needsFacts: Array<{ entry: Answer; leaf: string; match: ReturnType<typeof matchSpecTerm> }> = [];
  loose.forEach((e, i) => {
    const m = matches[i];
    if (m.kind === 'unique') {
      rows.push({
        project, file: e.file, expected: e.answer,
        predicted: LABEL_BY_STAGE[m.stages[0]] ?? null,
        path: 'naming_rule', namingKind: m.kind, namingTerm: m.term ?? null,
        requiresHumanReview: false,
        reasoning: `文件名对应规范里的「${m.term}」，未读取文件内容`,
        ms: 0,
      });
    } else {
      needsFacts.push({ entry: e, leaf: leaves[i], match: m });
    }
  });

  // ---------- ③ 先把整批事实全抽完，此时不判阶段 ----------
  console.log(`\n[${project}] ③ 抽事实 ${needsFacts.length} 份…`);
  const extracted: Array<{
    entry: Answer; leaf: string; match: ReturnType<typeof matchSpecTerm>;
    facts: DocumentFacts | null; contentChars: number; ms: number; error?: string;
  }> = [];

  for (const [i, it] of needsFacts.entries()) {
    const startedAt = Date.now();
    const tag = `   [${i + 1}/${needsFacts.length}] ${it.leaf.slice(0, 40)}`;
    try {
      const abs = join(dir, it.entry.file);
      const buffer = readFileSync(abs);
      const extension = extname(it.leaf).slice(1).toLowerCase();
      const mimeType = getMimeType(extension);
      // 先上传拿 storageKey——扫描件和 Office 文件本地抽不出文字，要回退到 Coze
      // 解析服务，而它需要签名 URL。不上传就只能给 base64 data: URL，解析必然失败，
      // 正文退化成文件名。前端每份文件都先 uploadToTemp，评测必须照做。
      const storageKey = await uploadTempFileFromBuffer({
        buffer, fileName: it.leaf, mimeType, projectId: EVAL_PROJECT_ID,
      });
      const content = await readDocumentContent({
        fileName: it.leaf, fileSize: statSync(abs).size, mimeType, extension,
        customHeaders: {}, fileBuffer: buffer, storageKey,
      });
      const result = await extractDocumentFacts({
        fileName: it.leaf, contentText: content.contentText,
        projectName: project, customHeaders: {}, imageDataUrl: content.imageDataUrl,
      });
      const chars = content.contentText.trim().length;
      extracted.push({ ...it, facts: result.facts, contentChars: chars, ms: Date.now() - startedAt });
      console.log(`${tag}  正文 ${chars} 字  (${((Date.now() - startedAt) / 1000).toFixed(1)}s)${chars < 30 ? '  ⚠️ 只有文件名' : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      extracted.push({ ...it, facts: null, contentChars: 0, ms: Date.now() - startedAt, error: message });
      console.log(`${tag}  失败: ${message.slice(0, 60)}`);
    }
  }

  // ---------- ④ 整批一次判阶段 ----------
  const ready = extracted.filter(e => e.facts);
  const decided = new Map<string, { stage: ArchiveBusinessStage | null; review: boolean; why: string; path: Path }>();

  if (ready.length > 1) {
    console.log(`\n[${project}] ④ 整批判阶段（${ready.length} 份一次调用）…`);
    const batchItems: BatchStageDecisionItem[] = ready.map(e => ({
      sourcePath: e.leaf,
      facts: e.facts!,
      namingHint: e.match.kind === 'ambiguous' && e.match.term
        ? { term: e.match.term, stages: e.match.stages } : undefined,
    }));
    const batch = await decideStagesForBatchWithModel({ items: batchItems, projectName: project, customHeaders: {} });
    batch.decisions.forEach((d, i) => {
      if (!d) return;
      decided.set(ready[i].entry.file, {
        stage: d.businessStage, review: d.requiresHumanReview, why: d.reasoning, path: 'batch_decide',
      });
    });
    console.log(`   模型给出 ${decided.size}/${ready.length} 份结论`);
  }

  // ---------- ⑤ 整批漏判的退回逐份判（前端的兜底分支） ----------
  const fallback = ready.filter(e => !decided.has(e.entry.file));
  if (fallback.length) {
    console.log(`\n[${project}] ⑤ 退回逐份判 ${fallback.length} 份…`);
    for (const e of fallback) {
      const d = await decideStageWithModel({
        sourcePath: e.leaf, facts: e.facts!, projectName: project,
        namingHint: e.match.kind === 'ambiguous' && e.match.term
          ? { term: e.match.term, stages: e.match.stages } : undefined,
        customHeaders: {},
      });
      decided.set(e.entry.file, {
        stage: d.decision?.businessStage ?? null,
        review: d.decision?.requiresHumanReview ?? true,
        why: d.decision?.reasoning ?? d.error ?? '',
        path: 'single_decide',
      });
    }
  }

  for (const e of extracted) {
    const d = decided.get(e.entry.file);
    rows.push({
      project, file: e.entry.file, expected: e.entry.answer,
      predicted: d?.stage ? LABEL_BY_STAGE[d.stage] : null,
      path: e.error ? 'error' : (d?.path ?? 'batch_decide'),
      namingKind: e.match.kind, namingTerm: e.match.term ?? null,
      requiresHumanReview: d?.review ?? true,
      reasoning: d?.why ?? '', ms: e.ms, contentChars: e.contentChars, error: e.error,
    });
  }
  return rows;
}

function report(rows: Row[], targetSet: string) {
  const stages = Object.keys(STAGE_BY_LABEL);
  const total = rows.length;
  const correct = rows.filter(r => r.predicted === r.expected).length;
  const expectedCounts = new Map<string, number>();
  for (const r of rows) expectedCounts.set(r.expected, (expectedCounts.get(r.expected) ?? 0) + 1);
  const [majorityStage, majorityCount] = [...expectedCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const L: string[] = [];
  const push = (s = '') => { L.push(s); console.log(s); };

  push(`\n${'='.repeat(64)}`);
  push(`评测集 ${targetSet} · ${total} 份 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  push('='.repeat(64));
  push(`总准确率   ${percent(correct, total)}  (${correct}/${total})`);
  push(`瞎猜基线   ${percent(majorityCount, total)}  (全填「${majorityStage}」)`);
  push('');
  push('阶段         份数   召回率   精确率');
  for (const s of stages) {
    const truth = rows.filter(r => r.expected === s);
    const pred = rows.filter(r => r.predicted === s);
    const hit = truth.filter(r => r.predicted === s).length;
    const note = truth.length === 0 ? '  无样本' : truth.length < 3 ? '  样本不足' : '';
    push(
      `${pad(s, 12)} ${String(truth.length).padStart(4)}   ` +
        (note ? `  -       -    ${note}`
              : `${percent(hit, truth.length).padStart(6)}   ${percent(hit, pred.length).padStart(6)}`)
    );
  }

  push('');
  push('链路             份数   准确率   平均耗时');
  const names: Record<Path, string> = {
    folder_rule: '文件夹分流', naming_rule: '命名规范短路',
    batch_decide: '整批判阶段', single_decide: '逐份兜底', error: '失败',
  };
  for (const p of Object.keys(names) as Path[]) {
    const sub = rows.filter(r => r.path === p);
    if (!sub.length) continue;
    const ok = sub.filter(r => r.predicted === r.expected).length;
    const avg = sub.reduce((a, r) => a + r.ms, 0) / sub.length / 1000;
    push(`${pad(names[p], 14)} ${String(sub.length).padStart(4)}   ${percent(ok, sub.length).padStart(6)}   ${avg.toFixed(1)}s`);
  }

  const undecided = rows.filter(r => r.predicted === null && r.path !== 'error');
  push('');
  push(`未判定 ${undecided.length} 份 · 需人工复核 ${rows.filter(r => r.requiresHumanReview).length} 份 · 读取失败 ${rows.filter(r => r.path === 'error').length} 份`);

  const starved = rows.filter(r => r.contentChars !== undefined && r.contentChars < 30);
  if (starved.length) {
    push('');
    push(`⚠️  ${starved.length} 份走事实链路的文件正文不足 30 字，模型只看到文件名。`);
    push('   这些份的结果不反映系统能力，先查内容读取再看准确率。');
  }

  const wrong = rows.filter(r => r.predicted !== r.expected);
  push('');
  push(`错题 ${wrong.length} 份：`);
  for (const r of wrong) {
    push(`  [${names[r.path]}] ${leafName(r.file)}`);
    push(`        应: ${r.expected}   实: ${r.predicted ?? '未判定'}` +
      (r.namingTerm ? `   词条:「${r.namingTerm}」` : '') +
      (r.contentChars !== undefined ? `   正文 ${r.contentChars} 字` : ''));
    if (r.error) push(`        错误: ${r.error.slice(0, 120)}`);
    else if (r.reasoning) push(`        理由: ${r.reasoning.slice(0, 120)}`);
  }

  push('');
  push('与线上的已知偏差：archivedDocuments / projectNotes / timeline 均为空；');
  push('未跑 /api/deepen（人工触发的旁路，另行评测）。');

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  writeFileSync(join(ROOT, `evaluation/reports/${targetSet}-${stamp}.md`), '```\n' + L.join('\n') + '\n```\n');
  writeFileSync(join(ROOT, `evaluation/reports/${targetSet}-latest.json`), JSON.stringify({ targetSet, total, correct, rows }, null, 2) + '\n');
  console.log(`\n报告已写入 evaluation/reports/${targetSet}-${stamp}.md`);
}

main().catch(error => { console.error(error); process.exit(1); });
