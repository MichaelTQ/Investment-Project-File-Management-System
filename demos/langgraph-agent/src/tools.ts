import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { buildTermIndex } from './fixture.js';
import { BUDGET, STAGE_LABEL, type ProjectDoc, type ToolCallRecord } from './types.js';

/**
 * 五个工具：四个便宜、一个贵。
 *
 * 贵的那个 (`extract_document_facts`) 就是预算的全部意义所在——读一份扫描件要走
 * OCR / 视觉模型。**agent 真正在做的决策就是"这份值不值得读"。**
 *
 * 工具描述里写清"什么时候用"，不只写"是什么"；但**不许出现任何业务结论**
 * （"章程通常属于投资实施"之类），那等于把删掉的关键词表用自然语言种回去。
 *
 * 这里用 LangChain 的 `tool()` 定义，好处是同一份定义既能 `bindTools` 给任何
 * 聊天模型，也能被下面自己写的执行节点直接调用。
 */

export interface ToolContext {
  targetSourcePath: string;
  /** 项目全部文件。读到新事实时就地更新，**不写回任何存储**。 */
  documents: ProjectDoc[];
  /** 已用掉的读取次数。 */
  extractCount: number;
  /** 本次新读出来的文件。 */
  gathered: string[];
  /** 轨迹，供最后打印。 */
  records: ToolCallRecord[];
  /** 每次 extract 模拟的耗时，测试里设 0。 */
  extractLatencyMs: number;
}

const TERM_INDEX = buildTermIndex();
const SPEC_TERMS = [...TERM_INDEX.keys()];

function leafName(sourcePath: string): string {
  return sourcePath.split('/').pop() ?? sourcePath;
}

function findDocument(documents: ProjectDoc[], fileName: string): ProjectDoc | undefined {
  const wanted = fileName.trim();
  return (
    documents.find(d => d.sourcePath === wanted) ??
    documents.find(d => leafName(d.sourcePath) === wanted) ??
    documents.find(d => leafName(d.sourcePath).startsWith(wanted))
  );
}

function describePlacement(doc: ProjectDoc): string {
  if (!doc.stage) return '尚未归档';
  const label = STAGE_LABEL[doc.stage];
  return doc.stageSource === 'human'
    ? `${label}（人工确认）`
    : `${label}（仅按文件名规则落位，未读内容）`;
}

function factsBrief(doc: ProjectDoc) {
  const f = doc.facts;
  return {
    标题: f.title,
    文档类型: f.documentType,
    日期: f.dates.map(d => `${d.meaning}：${d.date}`),
    主体: f.parties.map(p => `${p.name}（${p.role}）`),
    字段变更: f.transactionChanges.map(
      c => `${c.field} ${c.before ?? '未写明'} → ${c.after ?? '未写明'}`
    ),
    原文摘录: f.evidenceQuotes,
    事实来源: f.sourceQuality,
  };
}

/**
 * 把真实文件名对到规范词条。
 *
 * 线上这一步是模型做的（同义归一，整批一次调用），因为形变太多：规范写"立项评审
 * 纪要"，实际叫"立项会纪要"。demo 里退化成子串匹配，够跑通即可——**要点不在匹配
 * 算法，在于匹配之后的分流：命中唯一阶段就直接归档，跨阶段就必须读内容。**
 */
function normalizeToTerm(fileName: string): string | null {
  const base = fileName.replace(/\.[^.]+$/, '');
  const hit = SPEC_TERMS.filter(term => base.includes(term));
  if (hit.length === 0) return null;
  return hit.sort((a, b) => b.length - a.length)[0];
}

export function createTools(ctx: ToolContext) {
  const listProjectDocuments = tool(
    async () => {
      const list = ctx.documents.map(d => ({
        文件名: leafName(d.sourcePath),
        当前位置: describePlacement(d),
        内容读过吗: d.contentRead ? '是' : '否',
        是否本次要判断的文件: d.sourcePath === ctx.targetSourcePath ? '是' : '否',
      }));
      return JSON.stringify({ 共: list.length, documents: list }, null, 2);
    },
    {
      name: 'list_project_documents',
      description:
        '列出本项目全部文件：文件名、当前归档阶段、这个阶段是人工确认的还是仅按文件名规则落的、内容有没有被读取过。不需要参数。开始判断前先调它看清楚项目里有什么。',
      schema: z.object({}),
    }
  );

  const readDocumentFacts = tool(
    async ({ file_name }) => {
      const doc = findDocument(ctx.documents, file_name);
      if (!doc) return JSON.stringify({ error: `项目里没有这份文件：${file_name}` });
      if (!doc.contentRead) {
        return JSON.stringify({
          error: `《${leafName(doc.sourcePath)}》尚未读取过内容，没有已存事实。要看它的内容请用 extract_document_facts。`,
        });
      }
      return JSON.stringify(
        { 文件名: leafName(doc.sourcePath), 事实: factsBrief(doc) },
        null,
        2
      );
    },
    {
      name: 'read_document_facts',
      description:
        '取某份文件**已经存在**的事实，不产生新的读取开销。仅对"内容读取过"的文件有结果；没读过的文件要用 extract_document_facts。',
      schema: z.object({ file_name: z.string().describe('文件名，与清单里一致。') }),
    }
  );

  const getProjectTimeline = tool(
    async () => {
      const entries = ctx.documents
        .filter(d => d.contentRead)
        .flatMap(d =>
          d.facts.dates.map(date => ({
            日期: date.date,
            含义: date.meaning,
            出自: leafName(d.sourcePath),
            该文件归在: describePlacement(d),
          }))
        )
        .sort((a, b) => a.日期.localeCompare(b.日期));
      return JSON.stringify(
        entries.length > 0
          ? { timeline: entries }
          : { timeline: [], 说明: '还没有读过内容的文件，时间线是空的。' },
        null,
        2
      );
    },
    {
      name: 'get_project_timeline',
      description:
        '按日期排好的全项目时间线：每个日期出自哪份文件、含义是什么、那份文件归在哪。判断先后关系时用它。不需要参数。',
      schema: z.object({}),
    }
  );

  const matchNamingSpec = tool(
    async ({ file_name }) => {
      const term = normalizeToTerm(file_name);
      const stages = term ? TERM_INDEX.get(term) : undefined;
      if (!term || !stages || stages.length === 0) {
        return JSON.stringify({
          结论: '文件名对不上规范里的任何词条，规范没覆盖这个名字，请靠内容判断。',
        });
      }
      return JSON.stringify(
        {
          规范词条: term,
          规范把它列在: stages.map(s => STAGE_LABEL[s]),
          说明:
            stages.length > 1
              ? '该词条在规范里跨多个阶段，光靠名字定不了，必须看内容事实。'
              : '该词条在规范里只属于一个阶段，但这只是提示，与内容冲突时以内容为准。',
        },
        null,
        2
      );
    },
    {
      name: 'match_naming_spec',
      description:
        '拿一个文件名去对照客户的归档规范，看它对应哪个规范词条、该词条在规范里列在哪些阶段。词条跨多个阶段说明光靠名字定不了，必须看内容。',
      schema: z.object({ file_name: z.string().describe('要对照的文件名。') }),
    }
  );

  const extractDocumentFacts = tool(
    async ({ file_name }) => {
      // 预算闸门在工具里也要有一道：模型可能无视提示词里的次数限制。
      if (ctx.extractCount >= BUDGET.maxExtracts) {
        return JSON.stringify({
          error: `读取预算已用尽（上限 ${BUDGET.maxExtracts} 份）。请基于已有事实作答；若仍定不了，说清还缺一份记载什么的文件。`,
        });
      }
      const doc = findDocument(ctx.documents, file_name);
      if (!doc) return JSON.stringify({ error: `项目里没有这份文件：${file_name}` });
      if (doc.contentRead) {
        return JSON.stringify({
          提示: '这份文件的内容已经读过了，直接给出已存事实，未消耗读取次数。',
          文件名: leafName(doc.sourcePath),
          事实: factsBrief(doc),
        });
      }

      // 模拟一次 OCR / 视觉模型调用的耗时与开销。
      if (ctx.extractLatencyMs > 0) {
        await new Promise(resolve => setTimeout(resolve, ctx.extractLatencyMs));
      }
      if (doc.hiddenFacts) {
        doc.facts = doc.hiddenFacts;
        doc.contentRead = true;
      }
      ctx.extractCount += 1;
      ctx.gathered.push(doc.sourcePath);

      return JSON.stringify(
        {
          文件名: leafName(doc.sourcePath),
          事实: factsBrief(doc),
          剩余读取次数: BUDGET.maxExtracts - ctx.extractCount,
        },
        null,
        2
      );
    },
    {
      name: 'extract_document_facts',
      description: `读取一份文件的内容并抽取客观事实：文档类型、日期、主体、数值记载、字段变更（形如"某字段由 A 变更为 B"）、原文摘录。这个操作要调用视觉模型读扫描件，**慢且花钱，最多只能用 ${BUDGET.maxExtracts} 次**。挑那些真正能定结论的读，不要把次数花在看起来相关但定不了事的文件上。`,
      schema: z.object({ file_name: z.string().describe('文件名，与清单里一致。') }),
    }
  );

  return [
    listProjectDocuments,
    readDocumentFacts,
    getProjectTimeline,
    matchNamingSpec,
    extractDocumentFacts,
  ];
}

export { leafName };
