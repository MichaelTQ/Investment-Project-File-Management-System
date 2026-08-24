/**
 * 离线评测：复刻前端那条真实链路，在本机 terminal 跑。
 *
 * 链路与 app/page.tsx 的批量分流一致（见该文件 4940-5030 行）：
 *
 *   ① 整批调 normalizeFilenamesWithModel 做文件名归一 → matchSpecTerm 查词条
 *   ② kind=unique（词条只对应一个阶段）→ 短路：直接定阶段，不读内容、不 OCR
 *   ③ 其余 → readDocumentContent（PDF 抽文本 / 扫描件与图片走 OCR）
 *            → extractDocumentFacts → decideStageWithModel
 *
 * 两条硬规矩：
 * - 进模型的一律只有 leafName()，不含目录。目录名就是标准答案，喂进去等于泄题。
 * - 调的是 src/ 下线上那几个模块本身，不是替代实现。
 *
 * 已知与线上的偏差（报告里也会打印，不要当成等价）：
 * - relatedDocuments 线上来自项目档案库（已归档文件的事实）。本机不连库，
 *   改为按处理顺序累积本次已抽到的事实。相当于"档案从空开始逐份归档"。
 * - projectNotes（项目负责人填的归档口径）为空。
 * - 不跑 /api/deepen。它是人工触发的旁路，且只取证不判阶段，另行评测。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

import { leafName } from '../src/lib/classification/source-path';
import { normalizeFilenamesWithModel } from '../src/lib/classification/filename-normalizer';
import { matchSpecTerm } from '../src/lib/classification/naming-spec';
import { readDocumentContent, getMimeType } from '../src/lib/classification/read-document-content';
import { extractDocumentFacts } from '../src/lib/classification/fact-extractor';
import { decideStageWithModel } from '../src/lib/classification/llm-stage-decision';
import type { DocumentFacts } from '../src/lib/classification/document-facts';
import type { ArchiveBusinessStage } from '../src/lib/folder-structure';

const ROOT = join(import.meta.dirname, '..');

/** 答案表里的中文阶段名 ↔ 代码里的阶段枚举。 */
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

const PROJECT_DIR: Record<string, string> = {
  君柔: '君柔档案',
  佰特微: '佰特微档案',
};

interface Answer {
  project: string;
  file: string;
  answer: string;
  set: string;
}

interface Row {
  project: string;
  file: string;
  expected: string;
  predicted: string | null;
  path: 'naming_rule' | 'facts' | 'error';
  namingKind: string;
  namingTerm: string | null;
  requiresHumanReview: boolean;
  reasoning: string;
  ms: number;
  error?: string;
}

function requireEnv() {
  const missing = ['COZE_INTEGRATION_MODEL_BASE_URL', 'COZE_WORKLOAD_IDENTITY_API_KEY'].filter(
    k => !process.env[k]?.trim()
  );
  if (missing.length) {
    console.error(
      `\n缺少环境变量：${missing.join('、')}\n` +
        `没有它们调不了模型。跑之前先 export，或写进 .env 后用 --env-file=.env 启动。\n`
    );
    process.exit(1);
  }
}

const percent = (num: number, den: number) => (den === 0 ? '  -  ' : `${((num / den) * 100).toFixed(1)}%`);

async function main() {
  const wantFinal = process.argv.includes('--final');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  const targetSet = wantFinal ? 'final' : 'dev';
  requireEnv();

  const answers: { entries: Answer[] } = JSON.parse(
    readFileSync(join(ROOT, 'evaluation/answers.json'), 'utf8')
  );
  const entries = answers.entries.filter(e => e.set === targetSet).slice(0, limit);
  if (!entries.length) {
    console.error(`answers.json 里没有 set=${targetSet} 的条目`);
    process.exit(1);
  }

  const projects = [...new Set(entries.map(e => e.project))];
  console.log(
    `\n评测集 ${targetSet}：${projects.join('、')}，共 ${entries.length} 份` +
      (wantFinal ? '   ⚠️  验收集，跑完请记录版本' : '')
  );

  const rows: Row[] = [];

  for (const project of projects) {
    const dir = join(ROOT, PROJECT_DIR[project]);
    const items = entries.filter(e => e.project === project);

    // ---------- ① 整批文件名归一（只给 leafName，不给目录） ----------
    console.log(`\n[${project}] ① 文件名归一 ${items.length} 份…`);
    const leaves = items.map(e => leafName(e.file));
    const normalized = await normalizeFilenamesWithModel({
      sourcePaths: leaves,
      customHeaders: {},
    });
    const matches = leaves.map((_, i) => matchSpecTerm(normalized.terms[i]));
    const counts = matches.reduce(
      (acc, m) => ({ ...acc, [m.kind]: acc[m.kind] + 1 }),
      { unique: 0, ambiguous: 0, unmatched: 0 } as Record<string, number>
    );
    console.log(
      `   唯一命中 ${counts.unique}（走短路） / 歧义 ${counts.ambiguous} / 未命中 ${counts.unmatched}（走事实链路）`
    );

    // ---------- ②③ 逐份判定 ----------
    const seen: Array<{ sourcePath: string; facts: DocumentFacts }> = [];

    for (const [i, item] of items.entries()) {
      const leaf = leaves[i];
      const match = matches[i];
      const startedAt = Date.now();
      const base: Omit<Row, 'predicted' | 'path' | 'requiresHumanReview' | 'reasoning' | 'ms'> = {
        project,
        file: item.file,
        expected: item.answer,
        namingKind: match.kind,
        namingTerm: match.term ?? null,
      };
      const tag = `   [${i + 1}/${items.length}] ${leaf.slice(0, 40)}`;

      // ② 唯一命中：直接定阶段，不读内容（复刻 app/page.tsx 的短路分支）
      if (match.kind === 'unique') {
        rows.push({
          ...base,
          predicted: LABEL_BY_STAGE[match.stages[0]] ?? null,
          path: 'naming_rule',
          requiresHumanReview: false,
          reasoning: `文件名对应规范里的「${match.term}」，未读取文件内容`,
          ms: Date.now() - startedAt,
        });
        console.log(`${tag}  → 短路 ${LABEL_BY_STAGE[match.stages[0]]}`);
        continue;
      }

      // ③ 其余：读内容（必要时 OCR）→ 抽事实 → 判阶段
      try {
        const abs = join(dir, item.file);
        const buffer = readFileSync(abs);
        const extension = extname(leaf).slice(1).toLowerCase();
        const content = await readDocumentContent({
          fileName: leaf,
          fileSize: statSync(abs).size,
          mimeType: getMimeType(extension),
          extension,
          customHeaders: {},
          fileBuffer: buffer,
        });
        const extracted = await extractDocumentFacts({
          fileName: leaf,
          contentText: content.contentText,
          projectName: project,
          customHeaders: {},
          imageDataUrl: content.imageDataUrl,
        });
        const facts = extracted.facts;
        const decision = await decideStageWithModel({
          sourcePath: leaf,
          facts,
          projectName: project,
          relatedDocuments: seen.slice(),
          namingHint:
            match.kind === 'ambiguous' && match.term
              ? { term: match.term, stages: match.stages }
              : undefined,
          customHeaders: {},
        });
        if (facts) seen.push({ sourcePath: leaf, facts });

        const stage = decision.decision?.businessStage ?? null;
        rows.push({
          ...base,
          predicted: stage ? (LABEL_BY_STAGE[stage] ?? null) : null,
          path: 'facts',
          requiresHumanReview: decision.decision?.requiresHumanReview ?? true,
          reasoning: decision.decision?.reasoning ?? decision.error ?? '',
          ms: Date.now() - startedAt,
        });
        console.log(
          `${tag}  → ${stage ? LABEL_BY_STAGE[stage] : '未判定'}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rows.push({
          ...base,
          predicted: null,
          path: 'error',
          requiresHumanReview: true,
          reasoning: '',
          ms: Date.now() - startedAt,
          error: message,
        });
        console.log(`${tag}  → 失败: ${message.slice(0, 60)}`);
      }
    }
  }

  report(rows, targetSet);
}

function report(rows: Row[], targetSet: string) {
  const stages = Object.keys(STAGE_BY_LABEL);
  const total = rows.length;
  const correct = rows.filter(r => r.predicted === r.expected).length;

  // 瞎猜基线：不看内容，全部填样本最多的那个阶段
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

  // 分阶段召回 / 精确；样本 < 3 不打分
  push('阶段         份数   召回率   精确率');
  for (const s of stages) {
    const truth = rows.filter(r => r.expected === s);
    const pred = rows.filter(r => r.predicted === s);
    const hit = truth.filter(r => r.predicted === s).length;
    const note = truth.length === 0 ? '  无样本' : truth.length < 3 ? '  样本不足' : '';
    push(
      `${s.padEnd(10, '　')} ${String(truth.length).padStart(4)}   ` +
        (note
          ? `  -       -    ${note}`
          : `${percent(hit, truth.length).padStart(6)}   ${percent(hit, pred.length).padStart(6)}`)
    );
  }

  // 按走了哪条路拆开——这条最能说明短路设计值不值
  push('');
  push('链路           份数   准确率   平均耗时');
  for (const p of ['naming_rule', 'facts', 'error'] as const) {
    const sub = rows.filter(r => r.path === p);
    if (!sub.length) continue;
    const ok = sub.filter(r => r.predicted === r.expected).length;
    const avg = sub.reduce((a, r) => a + r.ms, 0) / sub.length / 1000;
    const name = { naming_rule: '命名规范短路', facts: '读内容+OCR', error: '失败' }[p];
    push(`${name.padEnd(12, '　')} ${String(sub.length).padStart(4)}   ${percent(ok, sub.length).padStart(6)}   ${avg.toFixed(1)}s`);
  }

  const undecided = rows.filter(r => r.predicted === null && r.path !== 'error');
  const review = rows.filter(r => r.requiresHumanReview).length;
  push('');
  push(`未判定 ${undecided.length} 份 · 标记需人工复核 ${review} 份 · 读取失败 ${rows.filter(r => r.path === 'error').length} 份`);

  // 错题清单
  const wrong = rows.filter(r => r.predicted !== r.expected);
  push('');
  push(`错题 ${wrong.length} 份：`);
  for (const r of wrong) {
    push(`  [${r.path === 'naming_rule' ? '短路' : r.path === 'error' ? '失败' : '事实'}] ${leafName(r.file)}`);
    push(`        应: ${r.expected}   实: ${r.predicted ?? '未判定'}${r.namingTerm ? `   词条:「${r.namingTerm}」` : ''}`);
    if (r.error) push(`        错误: ${r.error.slice(0, 120)}`);
    else if (r.reasoning) push(`        理由: ${r.reasoning.slice(0, 120)}`);
  }

  push('');
  push('与线上的已知偏差：relatedDocuments 用本次累积的事实代替项目档案库；');
  push('projectNotes 为空；未跑 /api/deepen（人工触发的旁路，另行评测）。');

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  writeFileSync(join(ROOT, `evaluation/reports/${targetSet}-${stamp}.md`), '```\n' + L.join('\n') + '\n```\n');
  writeFileSync(join(ROOT, `evaluation/reports/${targetSet}-latest.json`), JSON.stringify({ targetSet, total, correct, rows }, null, 2) + '\n');
  console.log(`\n报告已写入 evaluation/reports/${targetSet}-${stamp}.md`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
