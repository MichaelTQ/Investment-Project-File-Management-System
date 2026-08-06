import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFallbackDocumentFacts,
  DocumentFactsSchema,
  extractFirstJsonObject,
  parseDocumentFactsResponse,
} from '../src/lib/classification/document-facts';
import {
  buildDocumentFactsPrompt,
  clearDocumentFactsCacheForTests,
  DOCUMENT_FACTS_MAX_OUTPUT_TOKENS,
  extractDocumentFacts,
  parseCompactDocumentFactsResponse,
} from '../src/lib/classification/fact-extractor';

const validFacts = {
  schemaVersion: 1,
  documentType: 'company_charter',
  rawDocumentType: '公司章程',
  title: '深圳君柔科技有限公司章程',
  documentNumber: null,
  version: '修订版',
  dates: [
    {
      date: '2026-04-10',
      meaning: '股东会批准日期',
      evidence: '2026年4月10日股东会一致通过',
    },
  ],
  parties: [
    {
      name: '深圳君柔科技有限公司',
      role: '项目公司',
    },
  ],
  signStatus: 'sealed',
  transactionChanges: [
    {
      field: '注册资本',
      before: '11.73624万元',
      after: '13.04027万元',
      evidence: '注册资本增加至人民币13.04027万元',
    },
  ],
  explicitStageClues: ['批准本次增资并修改公司章程'],
  evidenceQuotes: ['注册资本总额为人民币13.04027万元'],
  warnings: [],
  sourceQuality: 'visual_summary',
  extractionConfidence: 92,
};

test('可以从 Markdown 包裹内容中提取并校验事实 JSON', () => {
  const response = `分析如下：\n\`\`\`json\n${JSON.stringify(validFacts)}\n\`\`\``;
  const facts = parseDocumentFactsResponse(response);

  assert.equal(facts.documentType, 'company_charter');
  assert.equal(facts.transactionChanges[0].after, '13.04027万元');
  assert.equal(facts.extractionConfidence, 92);
});

test('JSON 提取器不会被字符串内部的大括号截断', () => {
  const response = 'prefix {"value":"包含 { 大括号 } 的文本","ok":true} suffix';
  assert.equal(
    extractFirstJsonObject(response),
    '{"value":"包含 { 大括号 } 的文本","ok":true}'
  );
});

test('Schema 保持严格，响应适配器可校正日期和越界置信度', () => {
  const rawFacts = {
    ...validFacts,
    dates: [
      {
        date: '2026/4/10',
        meaning: '日期',
        evidence: '原文',
      },
    ],
    extractionConfidence: 101,
  };
  assert.equal(DocumentFactsSchema.safeParse(rawFacts).success, false);

  const facts = parseDocumentFactsResponse(JSON.stringify(rawFacts));
  assert.equal(facts.dates[0]?.date, '2026-04-10');
  assert.equal(facts.extractionConfidence, 100);
  assert.match(facts.warnings.join('\n'), /结构化输出已校正/);
});

test('局部字段缺失或超长时保留其余事实而不是整份降级', () => {
  const facts = parseDocumentFactsResponse(
    JSON.stringify({
      ...validFacts,
      dates: [
        ...validFacts.dates,
        {
          date: '日期待确认',
          meaning: '工商变更日期',
          evidence: '原文未形成标准日期',
        },
      ],
      transactionChanges: [
        {
          field: '股东结构',
          before: null,
          after: '股东变化'.repeat(80),
          evidence: '股东会决议列明增资后股东结构',
        },
      ],
      explicitStageClues: undefined,
    })
  );

  assert.equal(facts.documentType, 'company_charter');
  assert.equal(facts.dates[1]?.date, null);
  assert.equal(facts.transactionChanges[0]?.after?.length, 100);
  assert.deepEqual(facts.explicitStageClues, []);
  assert.match(facts.warnings.join('\n'), /截断至 100/);
  assert.match(facts.warnings.join('\n'), /explicitStageClues/);
});

test('抽取失败时生成不参与自动决策的零置信度事实', () => {
  const fallback = createFallbackDocumentFacts(
    '目录/君柔科技-公司章程.pdf',
    '测试失败'
  );

  assert.equal(fallback.title, '君柔科技-公司章程');
  assert.equal(fallback.documentType, 'unknown');
  assert.equal(fallback.sourceQuality, 'filename_only');
  assert.equal(fallback.extractionConfidence, 0);
  assert.deepEqual(fallback.warnings, ['测试失败']);
});

test('事实抽取 Prompt 明确禁止执行归档分类并限制正文长度', () => {
  const messages = buildDocumentFactsPrompt({
    fileName: '公司章程.pdf',
    contentText: '章'.repeat(10_000),
    projectName: '君柔',
  });

  assert.match(String(messages[0].content), /不要选择归档目录/);
  assert.match(String(messages[0].content), /同一事实只能出现一次/);
  assert.match(String(messages[0].content), /短字段协议/);
  assert.ok(String(messages[1].content).length < 6_000);
});

/**
 * 事实的完整性优先于精简。
 *
 * 旧版给每个字段定了条数上限（日期 2 条、字段变化 3 条…），那些数字没有依据，
 * 而且丢哪几条由模型自己决定，事后不可知——信息量大的文件正好最容易被削掉
 * 决定性的那条日期或那处变更。现在只约束 JSON 总长度。
 */
test('抽取提示要求写全事实，不再限制每个字段几条', () => {
  const systemPrompt = String(
    buildDocumentFactsPrompt({
      fileName: '公司章程.pdf',
      contentText: '章程正文',
      projectName: '君柔',
    })[0].content
  );

  assert.match(systemPrompt, /能核实的事实都写下来/);
  assert.match(systemPrompt, /日期有几个写几个/);
  assert.match(systemPrompt, /1000 个字符以内/);
  // 不得再出现"最多输出 d N 项"这类逐字段条数上限。
  assert.equal(/最多输出 d \d/.test(systemPrompt), false);
  assert.equal(systemPrompt.includes('最小事实集合'), false);
});

test('输出上限留足余量，避免放宽条数后撞顶截断', () => {
  // 撞顶时 JSON 不完整、解析失败，整份事实退化成只含文件名的空壳。
  assert.ok(DOCUMENT_FACTS_MAX_OUTPUT_TOKENS >= 1_400);
});

// 回归：上限曾设为 600，而实测正常输出约 590 tokens。撞顶会让 JSON 截断、
// 解析失败并退化为只含文件名的空壳，且在界面上与"按策略转人工复核"无法区分。
test('输出因达到上限被截断时给出可区分的降级原因', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  const truncated = await extractDocumentFacts({
    fileName: '佰特微立项会纪要.pdf',
    contentText: '立项会议纪要',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        // 生成在中途停笔，括号未闭合。
        content: '{"dt":"meeting_minutes","t":"佰特微立项会纪要","d":[["2026-01-02","会议日期","会议于',
        finishReason: 'length',
      }),
    },
  }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(truncated.status, 'fallback');
  assert.equal(truncated.facts.sourceQuality, 'filename_only');
  assert.match(truncated.error ?? '', /上限被截断/);
  assert.match(truncated.facts.warnings.join('\n'), /上限被截断/);
  assert.equal(truncated.modelCall?.finishReason, 'length');
});

test('紧凑事实协议可恢复为稳定的完整 Schema', () => {
  const facts = parseCompactDocumentFactsResponse(JSON.stringify({
    dt: 'company_charter',
    r: '公司章程',
    t: '深圳君柔科技有限公司章程',
    n: null,
    v: '修订版',
    d: [['2026-04-10', '批准日期', '股东会一致通过']],
    p: [['深圳君柔科技有限公司', '项目公司']],
    s: 'b',
    c: [['注册资本', '11.73624万元', '13.04027万元', '注册资本增加']],
    g: ['批准增资并修改章程'],
    e: ['注册资本13.04027万元'],
    w: [],
    q: 'v',
    x: 92,
  }));

  assert.equal(facts.documentType, 'company_charter');
  assert.equal(facts.signStatus, 'signed_and_sealed');
  assert.equal(facts.sourceQuality, 'visual_summary');
  assert.equal(facts.transactionChanges[0]?.after, '13.04027万元');
});

test('事实抽取器支持注入客户端并对非法响应安全降级', async () => {
  const success = await extractDocumentFacts({
    fileName: '公司章程.pdf',
    contentText: '注册资本增加至人民币13.04027万元',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({ content: JSON.stringify(validFacts) }),
    },
  });
  assert.equal(success.status, 'success');
  assert.equal(success.facts.documentType, 'company_charter');

  const originalConsoleError = console.error;
  console.error = () => {};
  const fallback = await extractDocumentFacts({
    fileName: '公司章程.pdf',
    contentText: '',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({ content: '{"invalid":true}' }),
    },
  }).finally(() => {
    console.error = originalConsoleError;
  });
  assert.equal(fallback.status, 'fallback');
  assert.equal(fallback.facts.extractionConfidence, 0);
  assert.match(fallback.error ?? '', /Schema/);
});

test('相同内容指纹复用成功事实且不会再次调用模型', async () => {
  clearDocumentFactsCacheForTests();
  let calls = 0;
  const client = {
    invoke: async () => {
      calls += 1;
      return { content: JSON.stringify(validFacts) };
    },
  };
  const params = {
    fileName: '公司章程.pdf',
    contentText: '注册资本增加至人民币13.04027万元',
    projectName: '君柔',
    customHeaders: {},
    cacheKey: 'project-a:content_sha256:same-file',
    client,
  };

  const first = await extractDocumentFacts(params);
  const second = await extractDocumentFacts(params);

  assert.equal(first.cacheHit, undefined);
  assert.equal(second.cacheHit, true);
  assert.equal(second.modelCall, undefined);
  assert.equal(second.facts.documentType, 'company_charter');
  assert.equal(calls, 1);
});

test('写成文字的空值被还原为空，不会伪造出交易变化', () => {
  // 模型在紧凑元组协议里常把空值写成字符串 "null"。若原样存下，
  // "null → 11.73624万元" 会被下游读成"发生了一次增资"，把一份只是
  // 陈述注册资本的交易前章程误判成交易后版本。这是实测发生过的误判。
  const facts = parseCompactDocumentFactsResponse(
    JSON.stringify({
      dt: 'company_charter',
      r: '公司章程',
      t: '君柔科技公司章程',
      n: 'N/A',
      v: '无',
      c: [['注册资本', 'null', '11.73624万元', '章程载明注册资本11.73624万元']],
      q: 't',
      x: 85,
      d: [],
      p: [],
      g: [],
      e: [],
      w: [],
    })
  );

  assert.equal(facts.transactionChanges[0].before, null);
  assert.equal(facts.transactionChanges[0].after, '11.73624万元');
  assert.equal(facts.documentNumber, null);
  assert.equal(facts.version, null);
  assert.equal(
    facts.warnings.some(warning => warning.includes('写成文字的空值')),
    true
  );
});

test('真实的变更前后值不受空值还原影响', () => {
  const facts = parseCompactDocumentFactsResponse(
    JSON.stringify({
      dt: 'company_charter',
      r: '公司章程',
      t: '君柔科技公司章程',
      c: [
        ['注册资本', '11.73624万元', '13.04027万元', '由11.73624万元增加至13.04027万元'],
      ],
      q: 't',
      x: 90,
      d: [],
      p: [],
      g: [],
      e: [],
      w: [],
    })
  );

  assert.equal(facts.transactionChanges[0].before, '11.73624万元');
  assert.equal(facts.transactionChanges[0].after, '13.04027万元');
  assert.equal(
    facts.warnings.some(warning => warning.includes('写成文字的空值')),
    false
  );
});

test('读不到内容时，仅凭文件名猜出的文档类型作废', async () => {
  clearDocumentFactsCacheForTests();
  const result = await extractDocumentFacts({
    fileName: '君柔科技公司章程.pdf',
    contentText: '',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        // 模型自报 q:'f'（仅文件名），却仍给出了一个像模像样的类型。
        content:
          '{"dt":"company_charter","r":"公司章程","t":"君柔科技公司章程","n":null,"v":null,"d":[],"p":[],"s":"x","c":[],"g":[],"e":[],"w":[],"q":"f","x":30}',
      }),
    },
  });

  assert.equal(result.status, 'success');
  // 类型必须降级，否则它会照常参与同类型比对、锚点资格判断和阶段推断。
  assert.equal(result.facts.documentType, 'unknown');
  assert.equal(result.facts.rawDocumentType, '未知');
  // 文件名本身保留在标题里，人工复核时仍看得到。
  assert.equal(result.facts.title, '君柔科技公司章程');
  assert.match(result.facts.warnings.join(''), /仅凭文件名/);
});

test('读到了内容时，文档类型正常保留', async () => {
  clearDocumentFactsCacheForTests();
  const result = await extractDocumentFacts({
    fileName: '君柔科技公司章程.pdf',
    contentText: '注册资本为人民币1000万元',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        content:
          '{"dt":"company_charter","r":"公司章程","t":"君柔科技公司章程","n":null,"v":null,"d":[],"p":[],"s":"x","c":[],"g":[],"e":[],"w":[],"q":"t","x":85}',
      }),
    },
  });

  assert.equal(result.facts.documentType, 'company_charter');
  assert.equal(result.facts.rawDocumentType, '公司章程');
});

test('模型填了 unknown 但写了中文类型名时，按中文名对回枚举', async () => {
  clearDocumentFactsCacheForTests();
  const result = await extractDocumentFacts({
    fileName: '7君柔科技-股东会决议.pdf',
    contentText: '注册资本由11.73624万元增加至13.04027万元',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        // 实测样本：内容全抽对了，dt 却是 unknown，r 写着"股东会决议"。
        content:
          '{"dt":"unknown","r":"股东会决议","t":"股东会决议","n":null,"v":null,"d":[],"p":[],"s":"b","c":[["注册资本","11.73624万元","13.04027万元","注册资本由11.73624万元增加至13.04027万元"]],"g":[],"e":[],"w":[],"q":"v","x":80}',
      }),
    },
  });

  assert.equal(result.facts.documentType, 'shareholder_resolution');
  // 原文表述保持不动，便于人工核对翻译是否正确。
  assert.equal(result.facts.rawDocumentType, '股东会决议');
});

test('中文类型名对不上枚举时保持 unknown，不硬凑', async () => {
  clearDocumentFactsCacheForTests();
  const result = await extractDocumentFacts({
    fileName: '某文件.pdf',
    contentText: '内容若干',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        content:
          '{"dt":"unknown","r":"情况说明","t":"情况说明","n":null,"v":null,"d":[],"p":[],"s":"x","c":[],"g":[],"e":[],"w":[],"q":"t","x":60}',
      }),
    },
  });

  assert.equal(result.facts.documentType, 'unknown');
});

test('读不到内容时不做类型恢复，那道闸不能被绕过', async () => {
  clearDocumentFactsCacheForTests();
  const result = await extractDocumentFacts({
    fileName: '股东会决议.pdf',
    contentText: '',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        // 只看到文件名，却照着文件名写了中文类型——不能靠恢复步骤救回来。
        content:
          '{"dt":"unknown","r":"股东会决议","t":"股东会决议","n":null,"v":null,"d":[],"p":[],"s":"x","c":[],"g":[],"e":[],"w":[],"q":"f","x":20}',
      }),
    },
  });

  assert.equal(result.facts.documentType, 'unknown');
});

/**
 * 模型自报的 sourceQuality 会与它自己的产出矛盾：一边抽出日期、字段变更、原文
 * 摘录，一边自报"只读到文件名"。旧逻辑单凭自报就把类型作废成 unknown，界面上
 * 大量 unknown 都出自这条路径——正确识别出的类型被静默销毁。以产出为准。
 */

test('自报只读到文件名但给出了原文事实时，类型不作废', async () => {
  clearDocumentFactsCacheForTests();
  const result = await extractDocumentFacts({
    fileName: '7君柔科技-股东会决议.pdf',
    contentText: '注册资本由11.73624万元增加至13.04027万元',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        // q:'f' 与下面的 d/c/e 直接矛盾：文件名里不会有这些内容。
        content:
          '{"dt":"shareholder_resolution","r":"股东会决议","t":"股东会决议","n":null,"v":null,"d":[["2026-04-10","批准日期","决议通过"]],"p":[],"s":"b","c":[["注册资本","11.73624万元","13.04027万元","由11.73624万元增加至13.04027万元"]],"g":[],"e":["注册资本由11.73624万元增加至13.04027万元"],"w":[],"q":"f","x":80}',
      }),
    },
  });

  assert.equal(result.facts.documentType, 'shareholder_resolution');
  assert.equal(result.facts.dates.length, 1);
  // 自相矛盾这件事要留痕，便于排查抽取质量。
  assert.match(result.facts.warnings.join(''), /自报只读到文件名/);
});

test('自报只读到文件名且确实什么都没抽到时，类型仍然作废', async () => {
  clearDocumentFactsCacheForTests();
  const result = await extractDocumentFacts({
    fileName: '股东会决议.pdf',
    contentText: '',
    projectName: '君柔',
    customHeaders: {},
    client: {
      invoke: async () => ({
        content:
          '{"dt":"shareholder_resolution","r":"股东会决议","t":"股东会决议","n":null,"v":null,"d":[],"p":[],"s":"x","c":[],"g":[],"e":[],"w":[],"q":"f","x":20}',
      }),
    },
  });

  assert.equal(result.facts.documentType, 'unknown');
  assert.match(result.facts.warnings.join(''), /仅凭文件名/);
});
