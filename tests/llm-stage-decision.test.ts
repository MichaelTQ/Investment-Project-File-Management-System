import assert from 'node:assert/strict';
import test from 'node:test';

import type { DocumentFacts } from '../src/lib/classification/document-facts';
import {
  buildDecisionFromParsed,
  buildBatchStageDecisionPrompt,
  buildStageDecisionPrompt,
  parseBatchStageDecisionResponse,
  parseLlmStageDecisionResponse,
} from '../src/lib/classification/llm-stage-decision';

function healthyFacts(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    schemaVersion: 1,
    documentType: 'company_charter',
    rawDocumentType: '公司章程',
    title: '君柔科技公司章程',
    documentNumber: null,
    version: null,
    dates: [],
    parties: [],
    signStatus: 'sealed',
    transactionChanges: [],
    explicitStageClues: [],
    evidenceQuotes: [],
    warnings: [],
    sourceQuality: 'text',
    extractionConfidence: 90,
    ...overrides,
  };
}

test('解析模型返回的阶段判断', () => {
  const parsed = parseLlmStageDecisionResponse(
    `{"stage":"investment_execution","review":false,"why":"文件记载注册资本已变更为新值","ev":["注册资本 1000万 → 1500万"],"cx":[]}`
  );
  assert.equal(parsed.stage, 'investment_execution');
  assert.equal(parsed.review, false);
  assert.deepEqual(parsed.evidence, ['注册资本 1000万 → 1500万']);
  assert.deepEqual(parsed.contradictions, []);
});

test('阶段值非法时报错，不静默降级', () => {
  assert.throws(
    () => parseLlmStageDecisionResponse('{"stage":"随便写的阶段","review":false}'),
    /未知阶段/
  );
});

test('unknown 表示判不出来，转人工', () => {
  const parsed = parseLlmStageDecisionResponse(
    '{"stage":"unknown","review":false,"why":"读不到有效内容","ev":[],"cx":[]}'
  );
  assert.equal(parsed.stage, null);

  const decision = buildDecisionFromParsed(parsed, healthyFacts());
  assert.equal(decision.status, 'insufficient');
  assert.equal(decision.selectedFolder, null);
  assert.equal(decision.requiresHumanReview, true);
});

test('模型自己写下存疑之处时强制转人工', () => {
  const decision = buildDecisionFromParsed(
    {
      stage: 'investment_execution',
      review: false,
      reasoning: '记载了变更后的注册资本',
      evidence: ['注册资本 1500万'],
      contradictions: ['与关联章程记载的金额对不上'],
    },
    healthyFacts()
  );
  assert.equal(decision.requiresHumanReview, true);
});

test('只读到文件名时强制转人工', () => {
  const decision = buildDecisionFromParsed(
    {
      stage: 'investment_execution',
      review: false,
      reasoning: '据文件名判断',
      evidence: [],
      contradictions: [],
    },
    healthyFacts({ sourceQuality: 'filename_only' })
  );
  assert.equal(decision.requiresHumanReview, true);
});

test('事实清楚且模型无异议时不强制复核', () => {
  const decision = buildDecisionFromParsed(
    {
      stage: 'due_diligence',
      review: false,
      reasoning: '文件是对标的的核查记录',
      evidence: ['尽职调查工作底稿'],
      contradictions: [],
    },
    healthyFacts({ documentType: 'due_diligence_report' })
  );
  assert.equal(decision.requiresHumanReview, false);
  assert.equal(decision.status, 'decided');
  assert.equal(decision.businessStage, 'due_diligence');
});

/**
 * 提示词不得夹带业务预设。这是这一版重构的核心约束：模型只应看到阶段定义和
 * 原始事实，不应看到"哪类文件通常属于哪个阶段"，也不应看到代码替它算好的结论。
 */

test('阶段说明不列举各阶段的常见文件类型', () => {
  const systemPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '公司章程.pdf',
      facts: healthyFacts(),
    })[0].content
  );

  // 阶段定义必须在，否则模型无从判断。
  assert.match(systemPrompt, /investment_execution/);
  // 但不能出现文件类型清单式的举例。
  for (const listed of [
    '立项申请',
    '立项报告',
    '商业计划书',
    '增资协议',
    '股东会决议',
    '缴款通知书',
    '出资证明书',
    '营业执照',
  ]) {
    assert.equal(
      systemPrompt.includes(listed),
      false,
      `阶段说明里出现了文件类型举例“${listed}”，模型会据此查表而不是推理`
    );
  }
});

test('提示词不预设某类文件指向某个阶段', () => {
  const systemPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '公司章程.pdf',
      facts: healthyFacts(),
    })[0].content
  );

  assert.equal(systemPrompt.includes('指向 investment_execution'), false);
  assert.equal(systemPrompt.includes('注册资本'), false);
  // 反过来，必须明确要求模型不要按"通常"归档、不要假设未见到的文件存在。
  assert.match(systemPrompt, /通常/);
  assert.match(systemPrompt, /不要假设项目里应当存在某份没有出现的文件/);
});

test('用户提示只提供事实与时间线，不含代码算出的结论', () => {
  const userPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '公司章程.pdf',
      facts: healthyFacts({ evidenceQuotes: ['注册资本为人民币1000万元'] }),
      relatedDocuments: [
        {
          sourcePath: '股东会决议.pdf',
          facts: healthyFacts({
            documentType: 'shareholder_resolution',
            title: '股东会决议',
            transactionChanges: [
              {
                field: '注册资本',
                before: '1000万元',
                after: '1500万元',
                evidence: '注册资本由1000万元增加至1500万元',
              },
            ],
          }),
        },
      ],
      timeline:
        '- 2026-04-10 股东会决议.pdf（已归入 investment_execution）：决议通过',
    })[1].content
  );

  // 事实照常提供。
  assert.match(userPrompt, /注册资本为人民币1000万元/);
  assert.match(userPrompt, /1000万元 → 1500万元/);
  assert.match(userPrompt, /2026-04-10/);
  // 但不能出现代码替模型下的结论。
  for (const verdict of [
    '已由代码确定',
    '形成于该笔交易',
    '请直接采用',
    '倾向性推测',
    '必须逐一比对',
  ]) {
    assert.equal(
      userPrompt.includes(verdict),
      false,
      `提示里出现了代码的结论“${verdict}”，模型看到的就不再是原始事实`
    );
  }
});

test('提示词只给文件名，不给目录路径（目录名往往就是人工归档的答案）', () => {
  const userPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '君柔档案/投资决策/财务资料/公司章程.pdf',
      facts: healthyFacts(),
      relatedDocuments: [
        {
          sourcePath: '君柔档案/投资实施/股东会决议.pdf',
          facts: healthyFacts({ documentType: 'shareholder_resolution' }),
        },
      ],
    })[1].content
  );

  assert.match(userPrompt, /公司章程\.pdf/);
  assert.match(userPrompt, /股东会决议\.pdf/);
  for (const directory of ['投资决策', '投资实施', '君柔档案', '财务资料']) {
    assert.equal(
      userPrompt.includes(directory),
      false,
      `提示里泄漏了归档目录名“${directory}”，模型无需推理即可读出答案`
    );
  }
  assert.equal(userPrompt.includes('/'), false);
});

test('其他文件的归档位置可参考，但提示词禁止把它当唯一依据', () => {
  const systemPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '公司章程.pdf',
      facts: healthyFacts(),
    })[0].content
  );

  assert.match(systemPrompt, /人工确认过的归档结果/);
  assert.match(systemPrompt, /不得只凭/);
  assert.match(systemPrompt, /必须结合本文件自身记载的内容/);
});

test('自报只读到文件名但有原文事实时，不算读不到，不因此强制复核', () => {
  const decision = buildDecisionFromParsed(
    {
      stage: 'investment_execution',
      review: false,
      reasoning: '文件记载注册资本已变更',
      evidence: ['注册资本 11.73624万元 → 13.04027万元'],
      contradictions: [],
    },
    healthyFacts({
      sourceQuality: 'filename_only',
      evidenceQuotes: ['注册资本由11.73624万元增加至13.04027万元'],
    })
  );
  assert.equal(decision.requiresHumanReview, false);
});

test('确实什么都没抽到时才按读不到处理，强制复核', () => {
  const decision = buildDecisionFromParsed(
    {
      stage: 'investment_execution',
      review: false,
      reasoning: '据文件名判断',
      evidence: [],
      contradictions: [],
    },
    healthyFacts({ sourceQuality: 'filename_only' })
  );
  assert.equal(decision.requiresHumanReview, true);
});

/**
 * 数值对照规则。
 *
 * 实测失败样本：先传交易后的章程和决议，再传交易前的章程，后者被归进了
 * investment_execution，理由是"同名章程已被人工归入该阶段"和"缴款截止日为
 * 2030-03-30"——两条都不成立。而决定性事实就在提示词里：决议记载注册资本
 * 由 A 变为 B，这份章程记的正是 A。模型有这个信息但没去对照。
 */
test('提示词要求优先做数值对照，且措辞不含业务词汇', () => {
  const systemPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '公司章程.pdf',
      facts: healthyFacts(),
    })[0].content
  );

  assert.match(systemPrompt, /数值对照是判断先后最直接的依据/);
  assert.match(systemPrompt, /等于 X，说明本文件形成于这次变更之前/);
  assert.match(systemPrompt, /优先于其他一切线索/);

  // 只查【判断要求】那一段。阶段定义里出现"交割""签署"是合法的阶段描述，
  // 不是判断规则——归档目录本来就按这套阶段划分，不描述它模型无从判断。
  const rules = systemPrompt.slice(systemPrompt.indexOf('【判断要求】'));
  for (const domainWord of ['注册资本', '增资', '股东会', '交割', '缴款']) {
    assert.equal(
      rules.includes(domainWord),
      false,
      `判断规则里出现了业务词汇“${domainWord}”`
    );
  }
});

test('命名规范提示是软约束，但走出候选要拿得出原文依据', () => {
  const userPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '君柔科技_立项表决结果(1).pdf',
      facts: healthyFacts(),
      namingHint: {
        term: '表决票',
        stages: ['investment_decision', 'exit_decision'],
      },
    })[1].content
  );

  assert.match(userPrompt, /仅供参考，不是限制/);
  // 可以走出候选，但必须引用原文；说不清就交人工，而不是随手挑一个。
  assert.match(userPrompt, /必须能引用文件原文说明为什么/);
  assert.match(userPrompt, /说不清就输出 unknown/);
  assert.match(userPrompt, /宁可多一些交人工的/);
  assert.match(userPrompt, /表决票/);
});

test('没有命名规范提示时，提示词里不出现规范相关内容', () => {
  const userPrompt = String(
    buildStageDecisionPrompt({
      sourcePath: '君柔信用报告.pdf',
      facts: healthyFacts(),
    })[1].content
  );
  assert.equal(userPrompt.includes('命名规范'), false);
});

test('整批判断按序号回填，模型漏一条不会让后面集体错位', () => {
  const parsed = parseBatchStageDecisionResponse(
    `{"d":[{"i":3,"stage":"investment_execution","review":0,"why":"记载变更后的值"},
           {"i":1,"stage":"investment_decision","review":1,"why":"记载变更前的值","ev":["注册资本 11.73624"],"cx":["签署状态不明"]}]}`,
    3
  );
  assert.equal(parsed[0]?.stage, 'investment_decision');
  assert.equal(parsed[0]?.review, true);
  assert.deepEqual(parsed[0]?.contradictions, ['签署状态不明']);
  // 第 2 份模型没给，必须留 null 交给调用方退回逐份判断，而不是错位成第 3 份的结论
  assert.equal(parsed[1], null);
  assert.equal(parsed[2]?.stage, 'investment_execution');
  assert.equal(parsed[2]?.review, false);
});

test('整批判断忽略越界序号和非法阶段', () => {
  const parsed = parseBatchStageDecisionResponse(
    `{"d":[{"i":9,"stage":"investment_execution"},{"i":1,"stage":"不存在的阶段"}]}`,
    2
  );
  // 越界的丢掉；阶段非法的降级为"未确定"，而不是整条作废
  assert.equal(parsed[0]?.stage, null);
  assert.equal(parsed[1], null);
});

test('整批判断的提示词要求每个序号都有结果', () => {
  const messages = buildBatchStageDecisionPrompt({
    items: [
      { sourcePath: 'a.pdf', facts: healthyFacts() },
      {
        sourcePath: 'b.pdf',
        facts: healthyFacts(),
        namingHint: { term: '公司章程', stages: ['investment_decision', 'investment_execution'] },
      },
    ],
  });
  const systemPrompt = String(messages[0].content);
  const userPrompt = String(messages[1].content);
  assert.match(systemPrompt, /必须为每一个序号都输出一条结果/);
  assert.match(systemPrompt, /不要因为它们一起提交就往同一个阶段归/);
  // 软约束的措辞在整批版本里同样不能丢
  assert.match(userPrompt, /仅供参考，不是限制/);
  assert.match(userPrompt, /【1】a\.pdf/);
  assert.match(userPrompt, /【2】b\.pdf/);
});
