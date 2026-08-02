import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  buildProjectContextPrompt,
  synthesizeProjectContext,
} from '../src/lib/classification/project-context-synthesizer';

function facts(
  documentType: DocumentFacts['documentType'],
  title: string,
  date: string
): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType,
    rawDocumentType: title,
    title,
    documentNumber: null,
    version: null,
    dates: [{ date, meaning: '形成日期', evidence: date }],
    parties: [{ name: '深圳测试科技有限公司', role: '目标公司' }],
    signStatus: 'signed',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: [`${title}于${date}形成`],
    warnings: [],
    sourceQuality: 'text',
    extractionConfidence: 90,
  };
}

const documents = [
  {
    sourcePath: '项目立项/立项申请书.pdf',
    facts: facts('project_initiation_application', '立项申请书', '2026-01-02'),
  },
  {
    sourcePath: '投资决策/投委会决议.pdf',
    facts: facts(
      'investment_committee_resolution',
      '投资决策委员会决议',
      '2026-02-03'
    ),
  },
];

test('项目上下文综合器只保留能追溯到当前文件的事件与关系', async () => {
  const client = {
    invoke: async () => ({
      content: JSON.stringify({
        schemaVersion: 1,
        projectName: '测试项目',
        targetCompany: '深圳测试科技有限公司',
        contextStatus: 'llm_synthesized',
        latestEvidencedStage: 'investment_decision',
        stageConfidence: 'high',
        importantCaveat: '阶段只表示现有证据覆盖范围。',
        timeline: [
          {
            date: '2026-02-03',
            eventType: 'investment_committee_approved',
            stage: 'investment_decision',
            title: '投委会形成决议',
            evidenceFiles: ['投资决策/投委会决议.pdf'],
            evidence: '投资决策委员会决议',
            confidence: 'high',
          },
          {
            date: null,
            eventType: 'hallucinated_payment',
            stage: 'investment_execution',
            title: '不存在的付款事件',
            evidenceFiles: ['不存在.pdf'],
            evidence: '无',
            confidence: 'low',
          },
        ],
        stageHypotheses: [
          {
            stage: 'investment_decision',
            confidence: 'high',
            evidenceFiles: ['投资决策/投委会决议.pdf'],
            reasoning: '存在投委会决议。',
          },
        ],
        documentRelations: [
          {
            fromSourcePath: '项目立项/立项申请书.pdf',
            toSourcePath: '投资决策/投委会决议.pdf',
            relationType: 'later_project_decision',
            evidence: '立项后形成投决。',
            confidence: 'medium',
          },
        ],
        conflicts: [],
        openQuestions: [],
      }),
    }),
  };

  const result = await synthesizeProjectContext({
    projectName: '测试项目',
    documents,
    client: client as never,
  });

  assert.equal(result.status, 'llm_synthesized');
  assert.equal(result.llmCallCount, 1);
  assert.equal(result.context.timeline.length, 1);
  assert.equal(result.context.timeline[0]?.eventType, 'investment_committee_approved');
  assert.equal(result.context.documentRelations?.length, 1);
  assert.match(
    result.context.synthesisWarnings?.join('\n') ?? '',
    /缺少有效来源文件/
  );
});

test('没有模型客户端时仍能从不同文档类型生成可删除重建的降级快照', async () => {
  const result = await synthesizeProjectContext({
    projectName: '测试项目',
    documents,
    allowLlm: false,
  });

  assert.equal(result.status, 'deterministic_fallback');
  assert.equal(result.llmCallCount, 0);
  assert.equal(result.context.timeline.length, 2);
  assert.equal(result.context.latestEvidencedStage, 'investment_decision');
  assert.deepEqual(
    result.context.timeline.map(event => event.evidenceFiles[0]),
    ['项目立项/立项申请书.pdf', '投资决策/投委会决议.pdf']
  );
});

test('综合提示明确禁止使用上传顺序推断项目阶段', () => {
  const prompt = buildProjectContextPrompt({
    projectName: '测试项目',
    factCards: [],
  });
  assert.match(String(prompt[0]?.content), /不能把文件上传顺序当作业务发生顺序/);
});
