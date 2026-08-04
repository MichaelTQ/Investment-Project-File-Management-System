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
  assert.match(String(messages[0].content), /最小事实集合/);
  assert.match(String(messages[0].content), /同一事实只能出现一次/);
  assert.match(String(messages[0].content), /短字段协议/);
  assert.ok(String(messages[1].content).length < 6_000);
  assert.equal(DOCUMENT_FACTS_MAX_OUTPUT_TOKENS, 600);
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
