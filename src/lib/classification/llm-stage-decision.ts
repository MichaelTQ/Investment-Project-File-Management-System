import { type Message } from 'coze-coding-dev-sdk';

import {
  getFolderForBusinessStage,
  type ArchiveBusinessStage,
} from '../folder-structure';
import {
  invokeChatCompletion,
  type ModelCallDiagnostics,
} from './chat-completions';
import {
  extractFirstJsonObject,
  hasContentEvidence,
  type DocumentFacts,
} from './document-facts';
import type { ContextClassificationDecision } from './minimal/types';
import { describeProjectNotes } from './project-notes';
import { leafName } from './source-path';

/**
 * 判阶段用的模型，可用 STAGE_DECISION_MODEL 环境变量覆盖。
 *
 * 实测 mini 不是信息不够而是推理不行：决议写着"由 11.73624 变更为 13.04027"、
 * 本文件记的是 11.73624，两个数都在提示词里、模型也把它写进了证据，却仍然判成
 * 变更之后的阶段，理由是"同名文件已归入该阶段"和"两个日期一致"。提示词里已经
 * 明确要求数值对照优先于其他线索，它照样绕过去。同一批事实交给 pro（冲突复核
 * 那一步）则一次推对。
 *
 * 抽事实那一步仍用 mini：那是照抄原文，不需要推理。
 * 换之前先跑 `node scripts/probe-model.mjs` 确认网关支持。
 */
export const LLM_STAGE_DECISION_MODEL =
  process.env.STAGE_DECISION_MODEL?.trim() || 'doubao-seed-2-0-pro-260215';
export const LLM_STAGE_DECISION_VERSION = 'llm-stage-decision-v2';
const LLM_STAGE_DECISION_MAX_OUTPUT_TOKENS = 500;
const LLM_STAGE_DECISION_TIMEOUT_MS = 90_000;

const STAGE_VALUES: ArchiveBusinessStage[] = [
  'pre_initiation',
  'initiation',
  'due_diligence',
  'investment_decision',
  'investment_execution',
  'post_investment',
  'exit_decision',
  'exit_execution',
];

/**
 * 业务阶段的定义。这是代码里唯一保留的业务描述，因为归档目录本身就是按这套
 * 阶段划分的——不告诉模型每个阶段是什么意思，它无从判断。
 *
 * 刻意**不列举**每个阶段常见的文件类型。曾经有一版列了清单（"立项申请、立项
 * 报告、立项会纪要…"），它会让模型跳过推理直接查表：清单上有的判得准，清单上
 * 没有的一律判错，且系统无法泛化到没见过的文件。
 *
 * 尽职调查和投资决策这两条改过一次，起因是佰特微那份 2024 年版章程反复被判到尽调。
 * 原来两条的**举证门槛不对等**：尽调写着"为核查而收集的标的方原始资料"，任何一份
 * 标的出具的材料都自证符合——它是标的出的，这一点文件自己就写着；而投资决策要求
 * "提交决策机构审议的材料"，一份标的的客观状态材料**永远不会在正文里写自己被提交
 * 审议**。加上提示词又禁止跨文件推理，模型手上能落地的证据只剩尽调那一句，于是
 * 一路滑过去。它给出的理由几乎是逐字复述定义，说明它在严格执行规则，是规则写错了。
 *
 * 改法不是给章程指定阶段（那就是把业务映射焊进代码），而是把两边的门槛拉平：
 * 尽调那句收到"核查动作本身"上，投资决策那句点明"这类材料不会自证被提交审议"。
 */
export const STAGE_DEFINITIONS = `pre_initiation 立项前：与项目方初步接触、建立保密安排、获取初步介绍材料的阶段。此时尚未走内部立项程序。
initiation 项目立项：正式启动项目、走内部立项审批的阶段。文件反映的是"决定投入资源开展调查"这一内部决策过程本身。
due_diligence 尽职调查：对标的开展业务、财务、法律、风控核查的阶段。文件反映的是**核查这一动作本身**：调查工作形成的记录、底稿与结论，或明确写明供某项核查使用的资料。标的方出具的、只是客观陈述自身状态的材料，如果看不出它与某项核查工作的关联，不足以据此判归本阶段——"这是标的方的原始资料"对每个阶段都成立，不是本阶段独有的特征。
investment_decision 投资决策：内部作出投或不投决定的阶段。文件反映的是提交决策机构审议的材料与决策结论，以及审议所依据的、交易发生之前的标的客观状态。注意这类客观状态材料**通常不会在正文里写明自己被提交审议**，不要因为找不到"已上会""供审议"之类的字样就排除本阶段。
investment_execution 投资实施：交易文件正式签署、条件交割、投资款支付的阶段。文件反映的是交易已经发生这一事实状态。
post_investment 投后管理：投资完成后持续跟踪被投企业的阶段。
exit_decision 退出决策：内部决定是否退出、如何退出的阶段。
exit_execution 退出执行：退出交易实际完成的阶段。`;

/**
 * 各方身份的说明。
 *
 * 阶段定义本身分不开"同一份材料的不同来源"：一份财务资料，由中介机构出具并随上会
 * 材料提交，和我方在调查阶段自行收集，按定义两边都说得通——尽职调查写着"为核查而
 * 收集的标的方原始资料"，投资决策写着"审议时所依据的标的状态"。实测《天士力FA财务
 * 尽调资料》就卡在这里，反复被判到尽职调查。
 *
 * 真正的区分点是**这份材料是谁出的、给谁用的**。
 *
 * 原先这段话把身份的唯一来源定为归档口径，结尾是"口径没有写明的身份不要臆测"。
 * 用意没错——防的是模型凭公司名联想（名字里带"基金"就当出资方）。但后果是**没填
 * 口径的项目，这整段提示等于不存在**：实测佰特微那份《投资项目合规性审查表》，
 * 落款上白纸黑字印着"子基金管理人：深圳国创致远""母基金管理人：中山火炬"，而模型
 * 被这一句禁止把名字和角色对应起来，于是"出资方签署放行"这个决定性依据用不上。
 *
 * 改法是把"不要臆测"拆成两种情况：文件自己写明的角色可以用——那是**照抄原文**，
 * 与抄注册资本同类；只凭名字联想的仍然禁止。口径优先级仍然最高。
 *
 * 注意这段话依旧不含任何"某类文件属于某阶段"的映射，它只是让模型知道有"来源"这个
 * 维度，以及去哪里找各方身份。
 */
export const PARTY_CONTEXT_HINT = `【判断时要分清"谁出的、给谁用的"】
同一份材料，出自不同主体、用于不同环节，可能分属不同阶段——例如中介机构出具并随
上会材料提交的资料，与我方在调查阶段自行收集的资料，归属未必相同。
各方身份（投资方、被投企业、中介机构、出资方、决策机构等）按下面的次序认定：
1. **归档口径里写明的**优先，按口径理解：文件名或文件夹名里出现这些公司、机构的
   名称时，用口径说明的角色去理解它。
2. 口径没有写明时，**文件自身写明的角色可以直接采用**——落款、签署栏、盖章处、
   当事方定义段里写着某主体是什么身份，那是文件自己的记载，照它理解即可，并在
   证据里引用那句原文。
3. 以上都没有时不要臆测：仅凭公司名称的字面（例如名字里含"基金""科技""医疗"）
   推断角色一律不允许，宁可说这一点看不出来。`;

export interface LlmStageDecisionParams {
  sourcePath: string;
  facts: DocumentFacts;
  projectName?: string;
  /** 同项目其他文件的事实，供模型自行比对。代码不做任何预处理和结论。 */
  relatedDocuments?: Array<{ sourcePath: string; facts: DocumentFacts }>;
  /** 按日期排好的项目时间线文本。 */
  timeline?: string;
  /**
   * 命名规范给出的候选阶段。**只作提示，不作闸门。**
   *
   * 规范覆盖不全是常态，硬性限定候选会逼出必错的答案：君柔的《立项表决结果》按名称
   * 对应规范里的"表决票"，而规范只把表决票列在投资决策和退出决策下——它实际属于
   * 项目立项，正确答案根本不在候选里。所以提示词里明确允许模型选候选之外的阶段。
   */
  namingHint?: { term: string; stages: ArchiveBusinessStage[] };
  /** 项目负责人填写的归档口径，原样进提示词。见 project-notes.ts。 */
  projectNotes?: string;
  customHeaders?: Record<string, string>;
}

export interface LlmStageDecisionResult {
  status: 'success' | 'fallback';
  decision: ContextClassificationDecision | null;
  modelCall?: ModelCallDiagnostics;
  error?: string;
}

/** 把一份文件的事实原样铺开。不筛选、不排序、不强调任何字段。 */
function factsBrief(facts: DocumentFacts): string {
  const lines = [
    `标题：${facts.title}`,
    `类型：${facts.documentType}（原文表述：${facts.rawDocumentType}）`,
    facts.documentNumber ? `编号：${facts.documentNumber}` : '',
    facts.version ? `版本：${facts.version}` : '',
    `签署状态：${facts.signStatus}`,
    `事实来源：${facts.sourceQuality}`,
  ].filter(Boolean);

  if (facts.dates.length > 0) {
    lines.push(
      `日期：${facts.dates
        .map(item => `${item.date ?? '未知'}（${item.meaning}）`)
        .join('；')}`
    );
  }
  if (facts.parties.length > 0) {
    lines.push(
      `主体：${facts.parties.map(item => `${item.name}[${item.role}]`).join('；')}`
    );
  }
  if (facts.transactionChanges.length > 0) {
    lines.push(
      `记载的字段变化：${facts.transactionChanges
        .map(
          item =>
            `${item.field} ${item.before ?? '未写明'} → ${item.after ?? '未写明'}`
        )
        .join('；')}`
    );
  }
  if (facts.explicitStageClues.length > 0) {
    lines.push(`业务动作：${facts.explicitStageClues.join('；')}`);
  }
  if (facts.evidenceQuotes.length > 0) {
    lines.push(`原文摘录：${facts.evidenceQuotes.join('；')}`);
  }
  if (facts.warnings.length > 0) {
    lines.push(`抽取提示：${facts.warnings.join('；')}`);
  }
  return lines.join('\n');
}

function relatedDocumentsBrief(
  documents: LlmStageDecisionParams['relatedDocuments']
): string {
  if (!documents || documents.length === 0) {
    return '项目里还没有其他文件。';
  }

  return documents
    .map(item => {
      const changes = item.facts.transactionChanges
        .map(
          change =>
            `${change.field} ${change.before ?? '未写明'} → ${change.after ?? '未写明'}`
        )
        .join('；');
      const quotes = item.facts.evidenceQuotes.slice(0, 2);
      return [
        `- ${leafName(item.sourcePath)}`,
        `  类型：${item.facts.documentType}，标题：${item.facts.title}`,
        changes ? `  记载的字段变化：${changes}` : '',
        quotes.length > 0 ? `  原文摘录：${quotes.join('；')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

export function buildStageDecisionPrompt(
  params: LlmStageDecisionParams
): Message[] {
  const systemPrompt = `你是投资项目档案归档专家。根据已经抽取好的文档事实和项目时间线，判断一份文件应当归入哪个业务阶段。

【可选阶段及其含义】
${STAGE_DEFINITIONS}

${PARTY_CONTEXT_HINT}

【判断要求】
1. 只依据下面给出的事实和时间线。文件名可能不含任何阶段信息，不要单凭文件名判断。
2. 不要假设项目里应当存在某份没有出现的文件，也不要因为某类文件"通常"归在某个阶段就照此归档。判断依据必须来自这份文件自身记载的内容。
3. 项目已经走到哪一步，不代表当前文件属于哪一步——较早形成的文件依然属于更早的阶段。
4. 【其他文件的归档位置可以参考，但不能作为唯一依据】时间线里标注"人工确认归入某阶段"的，是人工确认过的归档结果，属于可信信息。但它说明的是那份文件的归属，不能直接推出本文件的归属——同一个项目里的文件本来就分属不同阶段。不得只凭"其他文件已归入某阶段"就判定本文件同属该阶段；必须结合本文件自身记载的内容（日期、数值、业务动作）说明为什么它属于这个阶段。
5. 【数值对照是判断先后最直接的依据，必须优先检查】如果其他文件记载了"某字段由 X 变为 Y"，而本文件记载的同一字段数值等于 X，说明本文件形成于这次变更之前；等于 Y 则说明形成于变更之后。存在这种对应关系时，它优先于其他一切线索，并且必须在理由中写明比对结果。
6. evidence 必须引用上面提供的事实原文，不得编造。
7. 事实不足以判断时输出 unknown，并在 why 里说明是哪些信息读不到。不要为了给出结论而猜测。
8. 存在任何存疑之处时把 review 设为 true。

【输出格式】
只输出一个 JSON 对象，不要输出 Markdown 或说明文字：
{
  "stage": "上述阶段枚举值之一，或 unknown",
  "review": true或false，是否建议人工复核,
  "why": "判断理由，不超过80字",
  "ev": ["支持该阶段的事实，每条不超过60字，最多3条"],
  "cx": ["存疑或与该阶段不符之处，每条不超过60字，最多2条，没有则输出 []"]
}`;

  const namingHintBlock = params.namingHint
    ? `

【命名规范的提示（仅供参考，不是限制）】
这份文件的名称对应归档规范里的「${params.namingHint.term}」，该条目在规范中出现在：${params.namingHint.stages.join('、')}。
规范只说明"通常叫这个名字的文件放在哪里"，它可能没有覆盖本项目的实际情况。
**请从上面的候选里选一个。** 这几个候选已经是规范圈定的范围，通常正确答案就在其中，先看哪一个与文件内容相符。
只有当文件内容与**所有候选都明显对不上**时，才输出 unknown 交人工——不要在候选之外自己另挑一个阶段。（实测反例：一份 2024 年版的公司章程，候选是投资决策和投资实施，模型却选了尽职调查，理由是"尽调阶段收集的原始资料"。这种时候应当在两个候选里选，或者输出 unknown。）`
    : '';

  const userPrompt = `【待归档文件名】
${leafName(params.sourcePath)}${namingHintBlock}${describeProjectNotes(
    params.projectNotes ?? ''
  )}

【该文件的文档事实】
${factsBrief(params.facts)}

【同项目其他文件的事实】
${relatedDocumentsBrief(params.relatedDocuments)}

【按日期排列的项目时间线】
${params.timeline || '项目里还没有带日期的文件。'}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/* ==================== 整批一次判断 ==================== */

/**
 * 逐份判断时，每一次调用都要把**同项目其他文件的事实和整条时间线**重发一遍。
 * 17 份文件就是 17 次调用、每次都驮着 17 份文件的上下文——输入量是 O(N²)，
 * 而其中 N-1 份的内容在每次调用里几乎一模一样。
 *
 * 整批一次判断把它压回 O(N)：上下文只发一遍，模型一次给出全部文件的归属。
 * 附带的好处是它能同时看到所有文件，君柔那对公司章程这类"必须两份放一起比才分得清"
 * 的情况，本来就更适合一次看完，而不是各判各的。
 *
 * 代价是风险集中：一次失败就全批没有结论，而且文件多时长上下文可能让每一份的判断
 * 都变粗。所以调用方必须保留逐份判断作为兜底，两条路都在，可以直接对照。
 */
const BATCH_STAGE_DECISION_MIN_OUTPUT_TOKENS = 800;
/**
 * 每份文件的输出预算。
 *
 * 按提示词允许的上限算：理由 60 字 + 证据 2×40 字 + 存疑 40 字 = 180 个汉字，
 * 加上 JSON 键名和阶段枚举，一份接近 260 token。之前按 140 估是照"模型会写得简短"
 * 拍的，撞上限的后果又特别重——整段 JSON 不完整就解析不了，全批作废。
 * 宁可多留一倍余量：这是输出上限不是实际用量，没撞到就不花钱。
 */
const BATCH_STAGE_DECISION_TOKENS_PER_FILE = 260;
const BATCH_STAGE_DECISION_MAX_OUTPUT_TOKENS = 8_000;
const BATCH_STAGE_DECISION_TIMEOUT_MS = 180_000;

export interface BatchStageDecisionItem {
  sourcePath: string;
  facts: DocumentFacts;
  namingHint?: { term: string; stages: ArchiveBusinessStage[] };
}

export function buildBatchStageDecisionPrompt(params: {
  items: BatchStageDecisionItem[];
  projectName?: string;
  projectNotes?: string;
  /** 本项目此前已归档文件的事实，作为背景。不参与本次判断。 */
  archivedDocuments?: Array<{ sourcePath: string; facts: DocumentFacts }>;
  timeline?: string;
}): Message[] {
  const systemPrompt = `你是投资项目档案归档专家。下面会一次给出同一个项目里的多份文件，请为**每一份**判断它应当归入哪个业务阶段。

【可选阶段及其含义】
${STAGE_DEFINITIONS}

${PARTY_CONTEXT_HINT}

【判断要求】
1. 只依据下面给出的事实和时间线。文件名可能不含任何阶段信息，不要单凭文件名判断。
2. 不要假设项目里应当存在某份没有出现的文件，也不要凭你自己认为的"这类文件通常放哪"去归档。判断依据必须来自这份文件自身记载的内容。**例外**：下面每份文件如果带了"命名规范提示"，那是客户自己写的归档口径，不是你的常识，按第 11 条处理。
3. 项目已经走到哪一步，不代表某份文件属于哪一步——较早形成的文件依然属于更早的阶段。
4. 【逐份独立判断，但要互相参照】这批文件属于同一个项目，可能分属不同阶段，不要因为它们一起提交就往同一个阶段归。同时，一份文件记载的事实可以用来给另一份定位。
5. 【数值对照是判断先后最直接的依据，必须优先检查】如果某份文件记载了"某字段由 X 变为 Y"，而另一份记载的同一字段数值等于 X，说明后者形成于这次变更之前；等于 Y 则说明形成于变更之后。存在这种对应关系时，它优先于其他一切线索，并且必须在理由中写明比对结果。
6. 【时间线里标注的归档位置】标着"人工确认归入"的是人工结论，可信度较高；标着"按命名规范归入、未经人工确认"的只是按文件名落位、没有人读过内容，不要把它当作依据。两者都不能单独用来推断本批文件的归属。
7. ev 必须引用上面提供的事实原文，不得编造。
8. 事实不足以判断时该文件输出 unknown，并在 why 里说明是哪些信息读不到。不要为了给出结论而猜测。
9. 存在任何存疑之处时把 review 设为 1。
10. **必须为每一个序号都输出一条结果，一条都不能少**，顺序不限但序号必须对应。
11. 【带了命名规范提示的文件，只能在给出的候选里选】那几个候选是客户归档口径圈定的范围，通常正确答案就在其中。先逐个看哪一个与文件内容相符；只有当文件内容与**所有候选都明显对不上**时才输出 unknown 交人工，**不要在候选之外自己另挑一个阶段**。（实测反例：一份 2024 年版的公司章程，候选是投资决策和投资实施，模型却选了尽职调查，理由是"尽调阶段收集的原始资料"——这个理由对任何一份标的方材料都成立，等于没有理由。这种时候应当在两个候选里选，或者输出 unknown。）

【输出格式】
只输出一个 JSON 对象，不要输出 Markdown 或说明文字：
{
  "d": [
    {
      "i": 文件序号,
      "stage": "上述阶段枚举值之一，或 unknown",
      "review": 1或0，是否建议人工复核,
      "why": "判断理由，不超过60字",
      "ev": ["支持该阶段的事实，每条不超过40字，最多2条"],
      "cx": ["存疑或与该阶段不符之处，不超过40字，最多1条，没有则省略"]
    }
  ]
}`;

  const archivedBrief =
    params.archivedDocuments && params.archivedDocuments.length > 0
      ? params.archivedDocuments
          .map(item => `- ${leafName(item.sourcePath)}\n${indent(factsBrief(item.facts))}`)
          .join('\n')
      : '项目里还没有其他已归档文件。';

  const itemsBrief = params.items
    .map((item, index) => {
      const hint = item.namingHint
        ? `\n  命名规范提示：名称对应「${item.namingHint.term}」，规范把它列在 ${item.namingHint.stages.join('、')}。请从这几个候选里选一个；只有当文件内容与所有候选都明显对不上时，才输出 unknown，不要在候选之外自己另挑一个阶段。`
        : '';
      return `【${index + 1}】${leafName(item.sourcePath)}${hint}\n${indent(factsBrief(item.facts))}`;
    })
    .join('\n\n');

  const userPrompt = `【项目】
${params.projectName || '未提供'}${describeProjectNotes(params.projectNotes ?? '')}

【本项目此前已归档文件的事实（背景，不需要为它们输出结论）】
${archivedBrief}

【按日期排列的项目时间线】
${params.timeline || '项目里还没有带日期的文件。'}

【待判断的文件，共 ${params.items.length} 份】
${itemsBrief}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function indent(value: string): string {
  return value
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

/**
 * 解析整批结果，按序号回填。
 *
 * 必须按序号而不是按数组顺序：模型少给一条或多给一条时，按顺序对齐会让后面所有文件
 * **集体错位**——那种错误比少认几份严重得多，而且从界面上完全看不出来。
 * 没拿到结论的位置留 null，由调用方决定是退回逐份判断还是标为未确定。
 */
export function parseBatchStageDecisionResponse(
  value: string,
  expectedCount: number
): Array<ParsedModelStage | null> {
  const json = extractFirstJsonObject(value);
  if (!json) throw new Error('模型响应中没有合法 JSON 对象');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('模型响应中的 JSON 无法解析');
  }
  const entries = (parsed as Record<string, unknown> | null)?.d;
  if (!Array.isArray(entries)) throw new Error('模型响应里没有 d 数组');

  const results = new Array<ParsedModelStage | null>(expectedCount).fill(null);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const index = Number(record.i) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) continue;

    const rawStage = typeof record.stage === 'string' ? record.stage.trim() : '';
    const stage = STAGE_VALUES.includes(rawStage as ArchiveBusinessStage)
      ? (rawStage as ArchiveBusinessStage)
      : null;

    results[index] = {
      stage,
      // 整批输出用 1/0 更省 token，同时兼容布尔。
      review: record.review === 1 || record.review === true,
      reasoning:
        typeof record.why === 'string' && record.why.trim()
          ? record.why.trim().slice(0, 200)
          : '模型未给出理由。',
      evidence: stringList(record.ev, 2),
      contradictions: stringList(record.cx, 1),
    };
  }
  return results;
}

export interface BatchStageDecisionResult {
  status: 'success' | 'fallback';
  /** 与传入 items 一一对应；null 表示模型没给这一份的结论。 */
  decisions: Array<ContextClassificationDecision | null>;
  modelCall?: ModelCallDiagnostics;
  error?: string;
}

export async function decideStagesForBatchWithModel(params: {
  items: BatchStageDecisionItem[];
  projectName?: string;
  projectNotes?: string;
  archivedDocuments?: Array<{ sourcePath: string; facts: DocumentFacts }>;
  timeline?: string;
  customHeaders?: Record<string, string>;
}): Promise<BatchStageDecisionResult> {
  const { items } = params;
  if (items.length === 0) return { status: 'success', decisions: [] };

  let modelCall: ModelCallDiagnostics | undefined;
  try {
    const response = await invokeChatCompletion({
      messages: buildBatchStageDecisionPrompt(params),
      model: LLM_STAGE_DECISION_MODEL,
      temperature: 0.1,
      maxOutputTokens: Math.min(
        BATCH_STAGE_DECISION_MAX_OUTPUT_TOKENS,
        Math.max(
          BATCH_STAGE_DECISION_MIN_OUTPUT_TOKENS,
          items.length * BATCH_STAGE_DECISION_TOKENS_PER_FILE
        )
      ),
      customHeaders: params.customHeaders,
      responseFormat: 'json_object',
      timeoutMs: BATCH_STAGE_DECISION_TIMEOUT_MS,
    });
    modelCall = response.diagnostics;
    const parsed = parseBatchStageDecisionResponse(
      response.content,
      items.length
    );
    const decidedCount = parsed.filter(Boolean).length;
    // 模型给的条数少于文件数时必须叫出来。缺的那几份会退回逐份判断，流程不会断，
    // 但如果每次都缺，说明输出预算或提示词有问题——不打日志就只能靠用户发现。
    if (decidedCount < items.length) {
      console.warn(
        `[batch-stage] 模型只给了 ${decidedCount}/${items.length} 份结论` +
          (modelCall?.finishReason === 'length'
            ? `，输出撞上 ${modelCall.maxOutputTokens} token 上限被截断`
            : '，未截断，是模型自己漏写的')
      );
    }
    return {
      status: 'success',
      decisions: parsed.map((item, index) =>
        item
          ? buildDecisionFromParsed(
              enforceNamingHintCandidates(item, items[index].namingHint),
              items[index].facts
            )
          : null
      ),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('Batch stage decision error:', error);
    const truncated = modelCall?.finishReason === 'length';
    return {
      status: 'fallback',
      decisions: new Array(items.length).fill(null),
      modelCall,
      error: truncated
        ? `整批阶段判断失败：输出被截断（${message}）`
        : `整批阶段判断失败：${message}`,
    };
  }
}

export interface ParsedModelStage {
  stage: ArchiveBusinessStage | null;
  review: boolean;
  reasoning: string;
  evidence: string[];
  contradictions: string[];
}

function stringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function parseLlmStageDecisionResponse(value: string): ParsedModelStage {
  const json = extractFirstJsonObject(value);
  if (!json) throw new Error('模型响应中没有合法 JSON 对象');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('模型响应中的 JSON 无法解析');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型响应不是 JSON 对象');
  }

  const payload = parsed as Record<string, unknown>;
  const rawStage = typeof payload.stage === 'string' ? payload.stage.trim() : '';
  const stage = STAGE_VALUES.includes(rawStage as ArchiveBusinessStage)
    ? (rawStage as ArchiveBusinessStage)
    : null;
  if (!stage && rawStage !== 'unknown' && rawStage !== '') {
    throw new Error(`模型返回了未知阶段：${rawStage.slice(0, 40)}`);
  }

  return {
    stage,
    review: payload.review === true,
    reasoning:
      typeof payload.why === 'string' && payload.why.trim()
        ? payload.why.trim().slice(0, 200)
        : '模型未给出理由。',
    evidence: stringList(payload.ev, 3),
    contradictions: stringList(payload.cx, 2),
  };
}

/**
 * 候选闸门：模型选了命名规范候选之外的阶段时，作废这个结论，转人工。
 *
 * 提示词里已经写了"只能在候选里选"，但那只是请求。实测佰特微那份章程，候选是
 * 投资决策和投资实施，模型仍然给了尽职调查，而解析那一步只校验它是不是合法枚举值，
 * 照单全收——界面于是出现"候选是 A、B，结论是 C"这种自相矛盾的展示。
 *
 * 作废而不是改判成某个候选：候选有两个，代码没有依据在它们之间挑，挑了就是瞎猜。
 * 交人工时把两个候选和模型的原话都带上，人一眼能看出该选哪个。
 *
 * 只对名称命中规范词条的文件生效，覆盖面很窄，不是把分类策略整体收紧。
 */
export function enforceNamingHintCandidates(
  parsed: ParsedModelStage,
  namingHint?: { term: string; stages: ArchiveBusinessStage[] }
): ParsedModelStage {
  if (!parsed.stage || !namingHint || namingHint.stages.length === 0) {
    return parsed;
  }
  if (namingHint.stages.includes(parsed.stage)) return parsed;

  return {
    ...parsed,
    stage: null,
    review: true,
    reasoning: `模型判为 ${parsed.stage}，但归档规范把「${namingHint.term}」列在 ${namingHint.stages.join('、')}，结论不在候选内，已转人工。模型原话：${parsed.reasoning}`,
    contradictions: [
      ...parsed.contradictions,
      `模型选择的 ${parsed.stage} 不在规范给出的候选（${namingHint.stages.join('、')}）之内`,
    ].slice(0, 2),
  };
}

/**
 * 整理成统一结构。
 *
 * 这里只剩两条规则，都与业务无关：模型自己说要复核、或它自己写下了存疑之处，
 * 就转人工。原先还有"投资合规性审查表一律人工过目""抽取完整度低于 60 分"等
 * 判断，前者是业务预设，后者是拍脑袋定的阈值，已删除。
 *
 * 事实完全读不到（只有文件名）时同样转人工——这一条是数据质量判断，不涉及
 * 任何业务知识。
 */
export function buildDecisionFromParsed(
  parsed: ParsedModelStage,
  facts: DocumentFacts
): ContextClassificationDecision {
  // 以有没有原文事实为准。模型自报的 sourceQuality 会与它自己的产出矛盾，
  // 只信自报会把一批读到了内容的文件误判成"读不到"。
  const unreadable =
    facts.sourceQuality === 'filename_only' && !hasContentEvidence(facts);
  const requiresHumanReview =
    !parsed.stage ||
    parsed.review ||
    parsed.contradictions.length > 0 ||
    unreadable;

  return {
    status: parsed.stage ? 'decided' : 'insufficient',
    selectedFolder: parsed.stage ? getFolderForBusinessStage(parsed.stage) : null,
    businessStage: parsed.stage,
    evidence: parsed.evidence,
    contradictions: parsed.contradictions,
    requiresHumanReview,
    reasoning: parsed.reasoning,
    policyVersion: LLM_STAGE_DECISION_VERSION,
  };
}

export async function decideStageWithModel(
  params: LlmStageDecisionParams
): Promise<LlmStageDecisionResult> {
  const messages = buildStageDecisionPrompt(params);
  let modelCall: ModelCallDiagnostics | undefined;

  try {
    const response = await invokeChatCompletion({
      messages,
      model: LLM_STAGE_DECISION_MODEL,
      temperature: 0.1,
      maxOutputTokens: LLM_STAGE_DECISION_MAX_OUTPUT_TOKENS,
      customHeaders: params.customHeaders,
      responseFormat: 'json_object',
      timeoutMs: LLM_STAGE_DECISION_TIMEOUT_MS,
    });
    modelCall = response.diagnostics;
    return {
      status: 'success',
      decision: buildDecisionFromParsed(
        enforceNamingHintCandidates(
          parseLlmStageDecisionResponse(response.content),
          params.namingHint
        ),
        params.facts
      ),
      modelCall,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('LLM stage decision error:', error);
    const truncated = modelCall?.finishReason === 'length';
    return {
      status: 'fallback',
      decision: null,
      modelCall,
      error: truncated
        ? `模型阶段判断失败：输出达到 ${LLM_STAGE_DECISION_MAX_OUTPUT_TOKENS} tokens 上限被截断（${message}）`
        : `模型阶段判断失败：${message}`,
    };
  }
}
