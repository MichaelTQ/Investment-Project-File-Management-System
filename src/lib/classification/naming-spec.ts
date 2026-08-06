import type { ArchiveBusinessStage } from '../folder-structure';

/**
 * 客户的归档规范：《国创致远-投资项目档案管理》。
 *
 * 这是**客户提供的业务口径**，不是我们按常识编的映射——两者的区别是这整套设计的
 * 前提。系统自己不得凭文件类型猜阶段；但客户明确写下"这个阶段应当有哪些文件"，
 * 那就是需求，可以照做。
 *
 * 结构刻意保持成「阶段 → 词条」，与规范文档的排版一致，方便逐行对照校核。
 * **歧义不是手写的，是数出来的**：同一个词条出现在几个阶段，由 buildTermIndex
 * 统计得出。这一点很重要——没有任何一处需要人来判断"这算不算歧义"，改了规范，
 * 歧义集自动跟着变。
 *
 * 词条用**归一后的说法**，而不是照抄规范原文。规范里同一个东西在不同阶段写法不同
 * （投资决策写"项目公司工商登记章程"、投资实施写"项目公司章程"；尽职调查写
 * "法律尽职调查报告"、投资决策写"法务尽调报告"），照抄的话数不出重复，歧义就漏了。
 * 真实文件名到词条的归一交给模型做，见 filename-normalizer.ts。
 *
 * 后续接 docx 导入时，只需要替换这个常量的来源，下面的推导和匹配一行都不用改。
 */
export interface NamingSpecSection {
  stage: ArchiveBusinessStage;
  /** 规范文档里这一栏的原始表述，出错时便于回查。 */
  label: string;
  terms: string[];
}

export const NAMING_SPEC: NamingSpecSection[] = [
  {
    stage: 'pre_initiation',
    label: '立项前',
    terms: ['保密协议'],
  },
  {
    stage: 'initiation',
    label: '项目立项',
    terms: ['立项申请书', '立项报告', '商业计划书', '立项评审纪要'],
  },
  {
    stage: 'due_diligence',
    label: '尽职调查',
    terms: [
      '业务尽职调查报告',
      '行业尽职调查报告',
      '财务尽职调查报告',
      '法律尽职调查报告',
    ],
  },
  {
    stage: 'investment_decision',
    label: '投资决策',
    terms: [
      '上会申请表',
      '营业执照',
      '经营许可批文',
      '贷款证',
      '担保明细',
      '公司章程',
      '纳税报表',
      '土地证',
      '房产证',
      '汇算清缴报告',
      '审计报告',
      '财务预测',
      '立项评审纪要',
      '投资建议书',
      '法律尽职调查报告',
      '财务尽职调查报告',
      '表决票',
      '投委会决议',
    ],
  },
  {
    stage: 'investment_execution',
    label: '投资实施',
    terms: [
      '增资协议',
      '股权转让协议',
      '股东协议',
      '投资者权利协议',
      '公司章程',
      '股东会决议',
      '董事会决议',
      '付款通知函',
      '转账凭证',
      '股东名册',
      '交割确认函',
      '股东出资证明书',
      '工商变更档案',
    ],
  },
  {
    stage: 'post_investment',
    label: '投后管理',
    terms: [
      '投后管理报告',
      '访谈记录',
      '调研照片',
      '审计报告',
      '风险处置方案',
      '台账',
    ],
  },
  {
    stage: 'exit_decision',
    label: '退出决策',
    terms: ['退出方案', '表决票', '投委会决议'],
  },
  {
    stage: 'exit_execution',
    label: '退出执行',
    terms: ['交易协议', '转账凭证', '项目档案移交表'],
  },
];

export interface SpecTermEntry {
  term: string;
  /** 该词条在规范里出现过的全部阶段，按规范顺序。 */
  stages: ArchiveBusinessStage[];
}

/**
 * 词条索引：词条 → 它在规范里出现过的所有阶段。
 *
 * 这就是"映射表"和"歧义表"——它们是同一张表，`stages.length > 1` 即歧义。
 */
export function buildTermIndex(
  spec: NamingSpecSection[] = NAMING_SPEC
): Map<string, ArchiveBusinessStage[]> {
  const index = new Map<string, ArchiveBusinessStage[]>();
  for (const section of spec) {
    for (const term of section.terms) {
      const stages = index.get(term);
      if (!stages) {
        index.set(term, [section.stage]);
      } else if (!stages.includes(section.stage)) {
        stages.push(section.stage);
      }
    }
  }
  return index;
}

const TERM_INDEX = buildTermIndex();

/** 规范里出现过的全部词条，去重后按规范顺序。交给模型做归一化时用这份清单。 */
export const SPEC_TERMS: string[] = [...TERM_INDEX.keys()];

export type NamingMatchKind =
  /** 词条只属于一个阶段，可以直接归档。 */
  | 'unique'
  /** 词条跨多个阶段，必须靠内容事实定夺。 */
  | 'ambiguous'
  /** 文件名对不上任何词条，规范没覆盖，走完整事实链路。 */
  | 'unmatched';

export interface NamingMatch {
  kind: NamingMatchKind;
  /** 归一到的规范词条。unmatched 时为 null。 */
  term: string | null;
  /**
   * 候选阶段。
   *
   * unique 时只有一个，可直接采用；ambiguous 时是几个候选，**只作提示不作闸门**
   * ——规范覆盖不全是常态，硬性限定会逼出必错的答案。君柔的
   * 《立项表决结果》就是实例：它其实属于项目立项，而规范里"表决票"只列在投资决策
   * 和退出决策下。
   */
  stages: ArchiveBusinessStage[];
}

/** 把归一后的词条翻译成归档判断。传 null 表示模型认为没有对应词条。 */
export function matchSpecTerm(term: string | null | undefined): NamingMatch {
  const normalized = term?.trim();
  if (!normalized) return { kind: 'unmatched', term: null, stages: [] };

  const stages = TERM_INDEX.get(normalized);
  // 模型返回了清单以外的词：按没匹配上处理，绝不猜。
  if (!stages || stages.length === 0) {
    return { kind: 'unmatched', term: null, stages: [] };
  }
  return {
    kind: stages.length === 1 ? 'unique' : 'ambiguous',
    term: normalized,
    stages: [...stages],
  };
}

/** 规范里跨阶段出现的词条。用于界面说明和自检，判断逻辑本身不依赖它。 */
export function listAmbiguousTerms(): SpecTermEntry[] {
  return [...TERM_INDEX.entries()]
    .filter(([, stages]) => stages.length > 1)
    .map(([term, stages]) => ({ term, stages: [...stages] }));
}
