import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  buildProjectContextPrompt,
  diagnoseMissingContextJson,
  PROJECT_CONTEXT_MAX_OUTPUT_TOKENS,
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

test('模型没有返回 JSON 时使用规则 Context 而不是标记更新失败', async () => {
  const result = await synthesizeProjectContext({
    projectName: '测试项目',
    documents,
    client: {
      invoke: async () => ({ content: '抱歉，本次无法生成结构化结果。' }),
    } as never,
  });

  assert.equal(result.status, 'deterministic_fallback');
  assert.equal(result.error, undefined);
  assert.equal(result.context.timeline.length, 2);
  assert.equal(result.context.latestEvidencedStage, 'investment_decision');
  assert.match(
    result.context.synthesisWarnings?.join('\n') ?? '',
    /非 JSON 文本|使用规则 Context/
  );
});

test('缺少 JSON 时区分空响应、非 JSON 文本和疑似截断', () => {
  assert.match(diagnoseMissingContextJson('   '), /空文本/);
  assert.match(diagnoseMissingContextJson('抱歉，无法完成。'), /非 JSON 文本/);
  assert.match(
    diagnoseMissingContextJson('{"timeline":[{"title":"未完成"}'),
    /未闭合|疑似输出在完成前被截断/
  );
});

test('首次 JSON 被截断时自动用紧凑模式重试', async () => {
  let invocationCount = 0;
  const result = await synthesizeProjectContext({
    projectName: '测试项目',
    documents,
    client: {
      invoke: async () => {
        invocationCount += 1;
        if (invocationCount === 1) {
          return {
            content: '{"schemaVersion":1,"timeline":[',
            finishReason: 'length',
            outputTokens: 8192,
          };
        }
        return {
          content: JSON.stringify({
            schemaVersion: 1,
            projectName: '测试项目',
            targetCompany: '深圳测试科技有限公司',
            contextStatus: 'llm_synthesized',
            latestEvidencedStage: 'investment_decision',
            stageConfidence: 'high',
            importantCaveat: '仅依据现有文件。',
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
            ],
            stageHypotheses: [],
            documentRelations: [],
            conflicts: [],
            openQuestions: [],
          }),
        };
      },
    } as never,
  });

  assert.equal(result.status, 'llm_synthesized');
  assert.equal(result.llmCallCount, 2);
  assert.equal(invocationCount, 2);
  assert.match(
    result.context.synthesisWarnings?.join('\n') ?? '',
    /紧凑模式重试成功|finish_reason=length|8192\/8192/
  );
});

test('综合提示明确禁止使用上传顺序推断项目阶段', () => {
  const prompt = buildProjectContextPrompt({
    projectName: '测试项目',
    factCards: [],
  });
  assert.match(String(prompt[0]?.content), /不能把文件上传顺序当作业务发生顺序/);
  assert.match(String(prompt[0]?.content), /timeline 最多 4 项/);
  assert.match(String(prompt[0]?.content), /不得逐份复述事实卡片/);
  assert.match(String(prompt[0]?.content), /无缩进的紧凑 JSON/);
  assert.doesNotMatch(String(prompt[0]?.content), /"schemaVersion": 1/);
  assert.equal(PROJECT_CONTEXT_MAX_OUTPUT_TOKENS, 3072);
});

test('成功调用会保留输出体量与耗时诊断', async () => {
  const result = await synthesizeProjectContext({
    projectName: '诊断项目',
    documents,
    client: {
      invoke: async () => ({
        content: JSON.stringify({
          targetCompany: null,
          latestEvidencedStage: 'unknown',
          stageConfidence: 'low',
          timeline: [],
          stageHypotheses: [],
          documentRelations: [],
          conflicts: [],
          openQuestions: [],
        }),
        finishReason: 'stop',
        outputTokens: 120,
      }),
    } as never,
  });
  assert.equal(result.modelCalls.length, 1);
  assert.equal(result.modelCalls[0]?.outputTokens, 120);
  assert.equal(result.modelCalls[0]?.finishReason, 'stop');
  assert.equal(result.modelCalls[0]?.maxOutputTokens, 3072);
  assert.ok((result.modelCalls[0]?.outputCharacters ?? 0) > 0);
});

test('模型返回过长字段时本地压缩且不产生第二次调用', async () => {
  let invocationCount = 0;
  const result = await synthesizeProjectContext({
    projectName: '超长输出项目',
    documents,
    client: {
      invoke: async () => {
        invocationCount += 1;
        return {
          content: JSON.stringify({
            targetCompany: '深圳测试科技有限公司',
            latestEvidencedStage: 'investment_decision',
            stageConfidence: 'high',
            importantCaveat: '长'.repeat(400),
            timeline: [
              {
                date: '2026-02-03',
                eventType: 'investment_committee_approved',
                stage: 'investment_decision',
                title: '投委会决议'.repeat(30),
                evidenceFiles: ['投资决策/投委会决议.pdf'],
                evidence: '证据'.repeat(200),
                confidence: 'high',
              },
            ],
            stageHypotheses: [],
            documentRelations: [],
            conflicts: [],
            openQuestions: Array.from({ length: 8 }, (_, index) =>
              `问题${index}${'长'.repeat(200)}`
            ),
          }),
        };
      },
    } as never,
  });

  assert.equal(invocationCount, 1);
  assert.equal(result.llmCallCount, 1);
  assert.equal(result.context.importantCaveat?.length, 200);
  assert.equal(result.context.timeline[0]?.title.length, 60);
  assert.equal(result.context.timeline[0]?.evidence.length, 160);
  assert.equal(result.context.openQuestions?.length, 5);
  assert.ok(
    result.context.openQuestions?.every(question => question.length <= 160)
  );
  assert.match(
    result.context.synthesisWarnings?.join('\n') ?? '',
    /超过项目 Context 预算，已在本地去重或截断/
  );
});
