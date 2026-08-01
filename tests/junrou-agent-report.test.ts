import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

interface AgentReportCase {
  id: string;
  agentStatus: 'decided' | 'needs_review';
  matchesGold: boolean;
  safeAbstention: boolean;
  requiresHumanReview: boolean;
  llmCallCount: number;
  trace: Array<{ node: string }>;
}

const projectRoot = process.cwd();
const report = JSON.parse(
  readFileSync(
    path.join(projectRoot, 'output/reports/junrou-agent-evaluation.json'),
    'utf8'
  )
) as {
  schemaVersion: number;
  graphVersion: string;
  mode: string;
  summary: {
    evaluatedCaseCount: number;
    suggestedCaseCount: number;
    suggestedCorrectCount: number;
    safeAbstentionCount: number;
    unsafeWrongSuggestionCount: number;
    humanReviewCount: number;
    agentLlmCallCount: number;
  };
  cases: AgentReportCase[];
};

function reportCase(id: string): AgentReportCase {
  const item = report.cases.find(candidate => candidate.id === id);
  if (!item) throw new Error(`Agent报告中缺少案例：${id}`);
  return item;
}

test('君柔Agent报告使用当前LangGraph版本并覆盖六个金标准', () => {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.graphVersion, 'classification-agent-langgraph-v1');
  assert.equal(report.mode, 'non-persistent-shadow');
  assert.equal(report.summary.evaluatedCaseCount, 6);
  assert.equal(report.cases.length, 6);
});

test('Agent明确建议全部命中且没有不安全猜测', () => {
  assert.equal(report.summary.suggestedCaseCount, 3);
  assert.equal(report.summary.suggestedCorrectCount, 3);
  assert.equal(report.summary.safeAbstentionCount, 3);
  assert.equal(report.summary.unsafeWrongSuggestionCount, 0);
  assert.equal(report.summary.humanReviewCount, 4);
  assert.equal(report.summary.agentLlmCallCount, 0);
  assert.equal(report.cases.every(item => item.llmCallCount === 0), true);
});

test('不同文档类型走不同Agent节点路径', () => {
  const charter = reportCase('junrou-charter-pre-transaction');
  assert.deepEqual(
    charter.trace.map(step => step.node),
    [
      'plan_evidence',
      'retrieve_related_document',
      'context_decision',
      'complete',
    ]
  );
  assert.equal(charter.matchesGold, true);

  const resolution = reportCase('junrou-shareholder-resolution');
  assert.deepEqual(
    resolution.trace.map(step => step.node),
    ['plan_evidence', 'context_decision', 'human_review']
  );
  assert.equal(resolution.safeAbstention, true);

  const compliance = reportCase('junrou-investment-compliance-review');
  assert.equal(compliance.matchesGold, true);
  assert.equal(compliance.agentStatus, 'needs_review');
  assert.equal(compliance.requiresHumanReview, true);
  assert.equal(compliance.trace.at(-1)?.node, 'human_review');
});

test('Markdown报告明确记录shadow与现有环境边界', () => {
  const markdown = readFileSync(
    path.join(projectRoot, 'output/reports/JUNROU_AGENT_EVALUATION.md'),
    'utf8'
  );
  assert.match(markdown, /LangGraph/);
  assert.match(markdown, /3\/3/);
  assert.match(markdown, /不写入 Supabase/);
  assert.match(markdown, /不改变 Coze 环境/);
  assert.match(markdown, /调度层 LLM 调用：0/);
});
