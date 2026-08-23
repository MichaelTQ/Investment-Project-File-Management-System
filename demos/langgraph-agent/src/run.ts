import { buildProject } from './fixture.js';
import { runAgent } from './graph.js';
import { gatewayModel, scriptedModel } from './model.js';
import { createTools } from './tools.js';
import { BUDGET, STAGE_LABEL } from './types.js';

/**
 * CLI。
 *
 *   npm run demo            # 离线，聚焦取证 → completed
 *   npm run demo:budget     # 离线，贪心乱读 → extract_budget
 *   npm run demo:real       # 接真网关，模型自己挑文件
 */

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) =>
  argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

const scenario = arg('scenario', 'focused') as 'focused' | 'greedy';
const modelKind = arg('model', 'scripted');
const target = '待归档/公司章程-B.pdf';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function main() {
  const documents = buildProject();

  const model =
    modelKind === 'gateway'
      ? await gatewayModel(
          createTools({
            targetSourcePath: target,
            documents,
            extractCount: 0,
            gathered: [],
            records: [],
            extractLatencyMs: 0,
          })
        )
      : scriptedModel(scenario === 'greedy' ? 'greedy' : 'focused');

  console.log(bold('\n投资档案分拣 · 取证 Agent（LangGraph 实现）'));
  console.log(
    dim(
      `模型：${model.label}　预算：${BUDGET.maxRounds} 轮 / ${BUDGET.maxExtracts} 次读取 / ${BUDGET.wallClockMs / 1000} 秒`
    )
  );
  console.log(dim(`目标文件：${target}`));
  console.log(dim(`项目里共 ${documents.length} 份文件，其中 ${documents.filter(d => !d.contentRead).length} 份没读过内容（扫描件）\n`));

  const result = await runAgent({
    targetSourcePath: target,
    documents,
    model,
    extractLatencyMs: 120, // 模拟一次视觉模型调用的耗时
  });

  console.log(bold('取证轨迹'));
  let round = 0;
  for (const record of result.records) {
    if (record.round !== round) {
      round = record.round;
      console.log(dim(`  ── 第 ${round} 轮 ──`));
    }
    const argText = Object.keys(record.args).length
      ? `(${Object.values(record.args).join(', ')})`
      : '()';
    const mark = record.isError ? '✗' : '·';
    const cost = record.tool === 'extract_document_facts' && !record.isError ? ' 💰' : '';
    console.log(`  ${mark} ${record.tool}${argText}${cost} ${dim(`${record.durationMs}ms`)}`);
    console.log(dim(`      ${record.brief}`));
  }

  console.log(bold('\n停止'));
  console.log(`  停止原因：${bold(result.stopReason)}`);
  console.log(`  用了 ${result.roundCount} 轮 / ${result.extractCount} 次读取 / ${result.totalDurationMs}ms`);
  console.log(`  读了：${result.gathered.map(p => p.split('/').pop()).join('、') || '（无）'}`);
  console.log(`  模型收尾：${result.closingNote}`);

  console.log(bold('\n判定器结论（不是 agent 判的）'));
  const decision = result.decision;
  if (!decision) {
    console.log('  没有结论。');
  } else {
    console.log(
      `  阶段：${decision.stage ? bold(STAGE_LABEL[decision.stage]) : bold('未能判定')}` +
        `　需人工确认：${decision.requiresHumanReview ? '是' : '否'}`
    );
    console.log(`  理由：${decision.reasoning}`);
    for (const item of decision.evidence) console.log(dim(`    - ${item}`));
  }
  console.log('');
}

main().catch(error => {
  console.error('\n运行失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
