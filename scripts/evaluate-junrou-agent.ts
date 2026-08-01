import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runClassificationAgent } from '../src/lib/classification/classification-agent';
import {
  parseProjectContextSnapshot,
  type RelatedDocumentFacts,
} from '../src/lib/classification/context-decision';
import type { DocumentFacts } from '../src/lib/classification/document-facts';

interface ShadowCase {
  id: string;
  relativePath: string;
  goldCategory: {
    folderId: string;
    fileName: string;
    folderPath: string[];
  };
  facts: DocumentFacts;
}

const projectRoot = process.cwd();
const outputRoot = path.join(projectRoot, 'output', 'reports');

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(path.join(projectRoot, relativePath), 'utf8')
  ) as T;
}

function sameCategory(
  left: { folderId: string; fileName: string } | null,
  right: { folderId: string; fileName: string }
): boolean {
  return left?.folderId === right.folderId && left.fileName === right.fileName;
}

async function main(): Promise<void> {
  const shadow = readJson<{ cases: ShadowCase[] }>(
    'output/reports/junrou-shadow-evaluation.json'
  );
  const projectContext = parseProjectContextSnapshot(
    readJson<unknown>('tests/fixtures/junrou-project-context.json')
  );
  if (!projectContext) throw new Error('君柔项目上下文不符合 Schema');

  const relatedCharters: RelatedDocumentFacts[] = shadow.cases
    .filter(item => item.facts.documentType === 'company_charter')
    .map(item => ({ sourcePath: item.relativePath, facts: item.facts }));
  const evaluated = [];

  for (const item of shadow.cases) {
    const result = await runClassificationAgent({
      sourcePath: item.relativePath,
      facts: item.facts,
      projectContext,
      availableRelatedDocuments: relatedCharters.filter(
        related => related.sourcePath !== item.relativePath
      ),
    });
    const matchesGold = sameCategory(
      result.decision.selectedCategory,
      item.goldCategory
    );
    evaluated.push({
      id: item.id,
      relativePath: item.relativePath,
      goldCategory: item.goldCategory,
      agentStatus: result.status,
      suggestedCategory: result.decision.selectedCategory,
      decisionStatus: result.decision.status,
      matchesGold,
      safeAbstention:
        result.status === 'needs_review' &&
        result.decision.selectedCategory === null,
      requiresHumanReview: result.decision.requiresHumanReview,
      rounds: result.rounds,
      llmCallCount: result.llmCallCount,
      requestedEvidence: result.requestedEvidence,
      trace: result.trace,
      graphVersion: result.graphVersion,
    });
  }

  const covered = evaluated.filter(item => item.suggestedCategory);
  const summary = {
    evaluatedCaseCount: evaluated.length,
    suggestedCaseCount: covered.length,
    suggestedCorrectCount: covered.filter(item => item.matchesGold).length,
    safeAbstentionCount: evaluated.filter(item => item.safeAbstention).length,
    unsafeWrongSuggestionCount: covered.filter(item => !item.matchesGold).length,
    humanReviewCount: evaluated.filter(item => item.agentStatus === 'needs_review')
      .length,
    agentLlmCallCount: evaluated.reduce(
      (sum, item) => sum + item.llmCallCount,
      0
    ),
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    graphVersion: 'classification-agent-langgraph-v1',
    mode: 'non-persistent-shadow',
    summary,
    cases: evaluated,
  };

  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(
    path.join(outputRoot, 'junrou-agent-evaluation.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );

  const rows = evaluated.map(item => {
    const suggestion = item.suggestedCategory?.fileName ?? '无结论';
    const outcome = item.suggestedCategory
      ? item.matchesGold
        ? '命中'
        : '错误建议'
      : '安全转人工';
    return `| ${item.relativePath} | ${item.goldCategory.fileName} | ${suggestion} | ${item.agentStatus} | ${item.rounds} | ${outcome} |`;
  });
  const markdown = `# 君柔分类 Agent Shadow 报告

## 1. 结论

本次使用 LangGraph 运行真实的分类 Agent 状态图。Agent 根据文档类型动态选择是否检索关联文件，可以循环补充证据，并在决定、证据不足或策略要求人工复核时停止。

- 评测案例：${summary.evaluatedCaseCount}；
- Agent 给出明确分类建议：${summary.suggestedCaseCount}；
- 明确建议命中：${summary.suggestedCorrectCount}/${summary.suggestedCaseCount}；
- 规则未覆盖时安全转人工：${summary.safeAbstentionCount}；
- 错误自主建议：${summary.unsafeWrongSuggestionCount}；
- Agent 调度层 LLM 调用：${summary.agentLlmCallCount}。

## 2. 逐文件结果

| 文件 | 金标准 | Agent建议 | 终止状态 | 检索轮次 | 结果 |
|---|---|---|---|---:|---|
${rows.join('\n')}

## 3. Agent 与固定流程的区别

Agent 并非对每份文件固定执行同一组步骤：公司章程会触发关联章程检索和对比；合规审查表在得到建议后因策略要求转人工；尚无规则的文档直接安全终止，不会调用 LLM 猜测。每个案例的 \`trace\` 保留了实际节点和工具路径。

## 4. 边界

该 Agent 目前是非持久化 shadow mode：不替换 legacy 分类，不触发自动归档，不写入 Supabase，不改变 Coze 环境。Agent 调度层当前使用可审计的确定性证据规则，LLM 只保留在前置文档事实抽取工具中。
`;
  writeFileSync(
    path.join(outputRoot, 'JUNROU_AGENT_EVALUATION.md'),
    markdown,
    'utf8'
  );
}

void main();
