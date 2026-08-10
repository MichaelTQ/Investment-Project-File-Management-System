import { leafName } from '../source-path';
import { describeStagePlacement, buildTimeline, describeTimeline } from '../minimal/evidence';
import { hasExtractedFacts, type MinimalDocument } from '../minimal/store';
import { matchSpecTerm } from '../naming-spec';
import { extractDocumentFacts } from '../fact-extractor';
import { readDocumentContent, getMimeType } from '../read-document-content';
import { getArchivedFileSource } from '../../storage';
import type { DocumentFacts } from '../document-facts';
import type { ModelCallDiagnostics } from '../chat-completions';
import { DEEPEN_BUDGET } from './types';

/**
 * 深挖旁路的五个工具。
 *
 * 四个便宜、一个贵。贵的那个（`extract_document_facts`）就是预算的全部意义所在——
 * 读一份扫描件要走 OCR/视觉模型，慢且花钱。**agent 真正在做的决策就是"这份值不值得读"。**
 *
 * 工具描述里写清"什么时候用"，不只写"是什么"——实测这对触发率有明显影响。
 * 但描述里**不许出现任何业务结论**（"章程通常属于投资实施"之类），那等于把已经删掉的
 * 关键词表用自然语言重新种回去。
 */

export interface DeepenToolContext {
  projectId: string;
  projectName?: string;
  targetSourcePath: string;
  /** 项目档案里的全部文件。深挖过程中就地更新（读到新事实时替换），但**不写回存储**。 */
  documents: MinimalDocument[];
  customHeaders: Record<string, string>;
  /** 已用掉的读取次数。 */
  extractCount: number;
  /** 本次深挖新读出来的事实，按 sourcePath 索引。 */
  gathered: Map<string, DocumentFacts>;
  modelCalls: ModelCallDiagnostics[];
}

/** OpenAI 兼容格式的工具定义。网关按这个格式透传给豆包。 */
export const DEEPEN_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_project_documents',
      description:
        '列出本项目全部文件：文件名、当前归档阶段、这个阶段是人工确认的还是仅按文件名规则落的、内容有没有被读取过。不需要参数。开始判断前先调它看清楚项目里有什么。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_document_facts',
      description:
        '取某份文件**已经存在**的事实，不产生新的读取开销。仅对"内容读取过"的文件有结果；没读过的文件要用 extract_document_facts。',
      parameters: {
        type: 'object',
        properties: {
          file_name: { type: 'string', description: '文件名，与清单里一致。' },
        },
        required: ['file_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_project_timeline',
      description:
        '按日期排好的全项目时间线：每个日期出自哪份文件、含义是什么、那份文件归在哪。判断先后关系时用它。不需要参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'match_naming_spec',
      description:
        '拿一个文件名去对照客户的归档规范，看它对应哪个规范词条、该词条在规范里列在哪些阶段。词条跨多个阶段说明光靠名字定不了，必须看内容。',
      parameters: {
        type: 'object',
        properties: {
          file_name: { type: 'string', description: '要对照的文件名。' },
        },
        required: ['file_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'extract_document_facts',
      description: `读取一份文件的内容并抽取客观事实：文档类型、日期、数值记载、字段变更（形如"某字段由 A 变更为 B"）、原文摘录。这个操作要调用视觉模型读扫描件，**慢且花钱，最多只能用 ${DEEPEN_BUDGET.maxExtracts} 次**。挑那些真正能定结论的读，不要把次数花在看起来相关但定不了事的文件上。`,
      parameters: {
        type: 'object',
        properties: {
          file_name: { type: 'string', description: '文件名，与清单里一致。' },
        },
        required: ['file_name'],
      },
    },
  },
];

/** 按文件名（叶子名）找文件。模型给的常常是叶子名而不是完整路径。 */
function findDocument(
  documents: MinimalDocument[],
  fileName: string
): MinimalDocument | undefined {
  const wanted = fileName.trim();
  return (
    documents.find(document => document.sourcePath === wanted) ??
    documents.find(document => leafName(document.sourcePath) === wanted) ??
    documents.find(document => leafName(document.sourcePath).startsWith(wanted))
  );
}

function factsBrief(facts: DocumentFacts) {
  return {
    标题: facts.title,
    文档类型: facts.documentType,
    日期: facts.dates.map(item => ({ 含义: item.meaning, 值: item.date })),
    字段变更: facts.transactionChanges.map(item => ({
      字段: item.field,
      变更前: item.before,
      变更后: item.after,
    })),
    原文摘录: facts.evidenceQuotes,
    事实来源: facts.sourceQuality,
    警告: facts.warnings,
  };
}

export interface ToolOutcome {
  /** 回给模型的内容，JSON 字符串。 */
  content: string;
  /** 写进轨迹的摘要。 */
  brief: string;
  isError: boolean;
}

function ok(payload: unknown, brief: string): ToolOutcome {
  return { content: JSON.stringify(payload, null, 2), brief, isError: false };
}

function fail(message: string): ToolOutcome {
  return {
    content: JSON.stringify({ error: message }),
    brief: message,
    isError: true,
  };
}

export async function runDeepenTool(
  name: string,
  rawArguments: string,
  context: DeepenToolContext
): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  if (rawArguments.trim()) {
    try {
      args = JSON.parse(rawArguments);
    } catch {
      return fail('参数不是合法 JSON，请重新发起调用。');
    }
  }
  const fileName =
    typeof args.file_name === 'string' ? args.file_name : undefined;

  switch (name) {
    case 'list_project_documents': {
      // 不做任何过滤。挑文件是模型的活，外面再筛一层只会削弱它——
      // 见 DEEPEN_AGENT_PLAN.md 第 2 节。
      const list = context.documents.map(document => ({
        文件名: leafName(document.sourcePath),
        当前位置: describeStagePlacement(document.stage, document.stageSource),
        内容读过吗: hasExtractedFacts(document) ? '是' : '否',
        是否本次要判断的文件:
          document.sourcePath === context.targetSourcePath ? '是' : '否',
      }));
      return ok(
        { 共: list.length, documents: list },
        `${list.length} 份文件`
      );
    }

    case 'read_document_facts': {
      if (!fileName) return fail('缺少 file_name。');
      const document = findDocument(context.documents, fileName);
      if (!document) return fail(`项目里没有这份文件：${fileName}`);
      if (!hasExtractedFacts(document)) {
        return fail(
          `《${leafName(document.sourcePath)}》尚未读取过内容，没有已存事实。要看它的内容请用 extract_document_facts。`
        );
      }
      return ok(
        { 文件名: leafName(document.sourcePath), 事实: factsBrief(document.facts) },
        `已存事实：${leafName(document.sourcePath)}`
      );
    }

    case 'get_project_timeline': {
      const text = describeTimeline(buildTimeline(context.documents), {
        showStage: true,
      });
      return ok({ timeline: text }, '时间线');
    }

    case 'match_naming_spec': {
      if (!fileName) return fail('缺少 file_name。');
      // 词条归一本身要调模型（filename-normalizer），深挖这里不再花一次调用，
      // 直接拿文件名去对表：对不上就如实说对不上，绝不猜。
      const matched = matchSpecTerm(fileName.replace(/\.[^.]+$/, ''));
      if (matched.kind === 'unmatched') {
        return ok(
          {
            结论: '文件名对不上规范里的任何词条，规范没覆盖这个名字，请靠内容判断。',
          },
          '规范未覆盖'
        );
      }
      return ok(
        {
          规范词条: matched.term,
          规范把它列在: matched.stages,
          说明:
            matched.kind === 'ambiguous'
              ? '该词条在规范里跨多个阶段，光靠名字定不了，必须看内容事实。'
              : '该词条在规范里只属于一个阶段，但这只是提示，与内容冲突时以内容为准。',
        },
        `规范词条：${matched.term}`
      );
    }

    case 'extract_document_facts': {
      if (!fileName) return fail('缺少 file_name。');
      if (context.extractCount >= DEEPEN_BUDGET.maxExtracts) {
        return fail(
          `读取预算已用尽（上限 ${DEEPEN_BUDGET.maxExtracts} 份）。请基于已有事实作答；若仍定不了，说清还缺一份记载什么的文件。`
        );
      }
      const document = findDocument(context.documents, fileName);
      if (!document) return fail(`项目里没有这份文件：${fileName}`);
      if (!document.archivedFileId) {
        return fail(
          `《${leafName(document.sourcePath)}》尚未归档，取不到原文件，读不了。`
        );
      }

      const source = await getArchivedFileSource(document.archivedFileId);
      if (!source || source.projectId !== context.projectId) {
        return fail(`取不到《${leafName(document.sourcePath)}》的原文件。`);
      }

      const extension =
        source.originalName.split('.').pop()?.toLowerCase() || '';
      // 与主链路共用同一条读取链路。两边读到的必须是同一个东西，否则评测无从对比。
      const read = await readDocumentContent({
        fileName: source.originalName,
        fileSize: source.fileSize,
        mimeType: source.mimeType || getMimeType(extension),
        extension,
        customHeaders: context.customHeaders,
        projectId: context.projectId,
        storageKey: source.storageKey,
      });
      context.modelCalls.push(...read.modelCalls);

      const extraction = await extractDocumentFacts({
        fileName: source.originalName,
        contentText: read.contentText,
        projectName: context.projectName ?? '',
        customHeaders: context.customHeaders,
        imageDataUrl: read.imageDataUrl,
        // 与主链路同一套缓存键：同一份文件在两条路上只会真读一次。
        cacheKey: `${context.projectId}:deepen:${document.archivedFileId}`,
      });
      if (extraction.modelCall) context.modelCalls.push(extraction.modelCall);

      context.extractCount += 1;
      context.gathered.set(document.sourcePath, extraction.facts);
      // 就地更新内存里的档案，后续 read_document_facts 和时间线能立刻用上。
      // **不写回存储**——写入只能走用户确认过的正常归档流程。
      const index = context.documents.findIndex(
        item => item.sourcePath === document.sourcePath
      );
      if (index >= 0) {
        context.documents[index] = {
          ...context.documents[index],
          facts: extraction.facts,
        };
      }

      return ok(
        {
          文件名: leafName(document.sourcePath),
          事实: factsBrief(extraction.facts),
          抽取状态: extraction.status,
          剩余读取次数:
            DEEPEN_BUDGET.maxExtracts - context.extractCount,
        },
        `读取 ${leafName(document.sourcePath)}（剩 ${DEEPEN_BUDGET.maxExtracts - context.extractCount} 次）`
      );
    }

    default:
      return fail(`未知工具：${name}`);
  }
}
