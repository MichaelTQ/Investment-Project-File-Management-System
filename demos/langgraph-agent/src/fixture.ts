import type { BusinessStage, DocFacts, ProjectDoc } from './types.js';

/**
 * 一个投资项目的档案快照。
 *
 * 结构、字段和证据链都照搬真实客户项目里那对公司章程的形态：两份同名同类型的章程，
 * 单看任何一份都判不出阶段，必须拿全项目的注册资本数字去比对。公司名和金额已改写，
 * 客户原件不进版本库。
 *
 * 关键设计：**扫描件的内容放在 hiddenFacts 里。** 不调 extract_document_facts 就
 * 看不到，和线上"没 OCR 过就只有文件名"完全一致——否则 agent 的取证决策没有意义。
 */

const filenameOnly = (title: string, type: string): DocFacts => ({
  documentType: type,
  title,
  dates: [],
  parties: [],
  transactionChanges: [],
  evidenceQuotes: [],
  sourceQuality: 'filename_only',
});

/** 归一化：抹掉千分位、单位和空白，只留可比的数字串。 */
export function normalizeValue(value: string): string {
  return value.replace(/[,，\s]/g, '').replace(/[（(].*?[)）]/g, '').trim();
}

export function buildProject(): ProjectDoc[] {
  return [
    {
      sourcePath: '立项前/保密协议.pdf',
      stage: 'pre_initiation',
      stageSource: 'naming_rule',
      contentRead: false,
      facts: filenameOnly('保密协议', 'confidentiality_agreement'),
    },
    {
      sourcePath: '项目立项/立项会纪要.pdf',
      stage: 'initiation',
      stageSource: 'human',
      contentRead: true,
      facts: {
        documentType: 'meeting_minutes',
        title: '标的科技有限公司立项评审会议纪要',
        dates: [{ meaning: '会议召开日', date: '2026-02-18' }],
        parties: [{ name: '标的科技有限公司', role: '标的公司' }],
        transactionChanges: [],
        evidenceQuotes: ['会议同意本项目立项，进入尽职调查阶段。'],
        sourceQuality: 'text',
      },
    },
    {
      sourcePath: '投资实施/增资协议.pdf',
      stage: 'investment_execution',
      stageSource: 'human',
      contentRead: true,
      facts: {
        documentType: 'capital_increase_agreement',
        title: '标的科技有限公司增资协议',
        dates: [{ meaning: '协议签署日', date: '2026-04-01' }],
        parties: [
          { name: '标的科技有限公司', role: '标的公司' },
          { name: '甲基金', role: '本轮投资方' },
          { name: '乙基金', role: '本轮投资方' },
        ],
        transactionChanges: [
          { field: '注册资本', before: '1173.624万元', after: '1304.027万元' },
        ],
        evidenceQuotes: ['本次增资完成后，公司注册资本由人民币1173.624万元增加至1304.027万元。'],
        sourceQuality: 'text',
      },
    },
    {
      // 本次要判断的目标文件：扫描件，没读过内容。
      sourcePath: '待归档/公司章程-B.pdf',
      stage: null,
      stageSource: null,
      contentRead: false,
      facts: filenameOnly('公司章程-B', 'company_charter'),
      hiddenFacts: {
        documentType: 'company_charter',
        title: '标的科技有限公司章程',
        dates: [{ meaning: '章程落款日', date: '2026-04-15' }],
        parties: [
          { name: '标的科技有限公司', role: '标的公司' },
          { name: '甲基金', role: '股东' },
          { name: '乙基金', role: '股东' },
          { name: '创始股东', role: '股东' },
        ],
        transactionChanges: [],
        evidenceQuotes: [
          '公司注册资本为人民币1304.027万元。',
          '股东名册载明甲基金、乙基金已列为公司股东。',
        ],
        sourceQuality: 'visual_summary',
      },
    },
    {
      // 干扰项：另一份同名同类型的章程，已人工归档在投资决策。
      sourcePath: '投资决策/公司章程-A.pdf',
      stage: 'investment_decision',
      stageSource: 'human',
      contentRead: false,
      facts: filenameOnly('公司章程-A', 'company_charter'),
      hiddenFacts: {
        documentType: 'company_charter',
        title: '标的科技有限公司章程',
        dates: [{ meaning: '章程落款日', date: '2025-11-20' }],
        parties: [
          { name: '标的科技有限公司', role: '标的公司' },
          { name: '创始股东', role: '股东' },
        ],
        transactionChanges: [],
        evidenceQuotes: [
          '公司注册资本为人民币1173.624万元。',
          '股东为创始股东一人。',
        ],
        sourceQuality: 'visual_summary',
      },
    },
    {
      sourcePath: '投资实施/股东会决议.pdf',
      stage: 'investment_execution',
      stageSource: 'human',
      contentRead: false,
      facts: filenameOnly('股东会决议', 'shareholder_resolution'),
      hiddenFacts: {
        documentType: 'shareholder_resolution',
        title: '标的科技有限公司股东会决议',
        dates: [{ meaning: '决议形成日', date: '2026-04-10' }],
        parties: [{ name: '标的科技有限公司', role: '标的公司' }],
        transactionChanges: [
          { field: '注册资本', before: '1173.624万元', after: '1304.027万元' },
        ],
        evidenceQuotes: [
          '同意公司注册资本由人民币1173.624万元变更为1304.027万元。',
          '同意相应修改公司章程。',
        ],
        sourceQuality: 'visual_summary',
      },
    },
    {
      sourcePath: '投资实施/电子回单.png',
      stage: 'investment_execution',
      stageSource: 'human',
      contentRead: false,
      facts: filenameOnly('电子回单', 'bank_receipt'),
      hiddenFacts: {
        documentType: 'bank_receipt',
        title: '银行电子回单',
        dates: [{ meaning: '付款日', date: '2026-04-29' }],
        parties: [{ name: '甲基金', role: '付款方' }],
        transactionChanges: [],
        evidenceQuotes: ['付款金额人民币1000万元，用途：增资款。'],
        sourceQuality: 'visual_summary',
      },
    },
    {
      sourcePath: '尽职调查/法务尽调报告.pdf',
      stage: 'due_diligence',
      stageSource: 'human',
      contentRead: false,
      facts: filenameOnly('法务尽调报告', 'due_diligence_report'),
      hiddenFacts: {
        documentType: 'due_diligence_report',
        title: '标的科技有限公司法律尽职调查报告',
        dates: [{ meaning: '报告出具日', date: '2026-03-05' }],
        parties: [{ name: '某律师事务所', role: '出具方' }],
        transactionChanges: [],
        evidenceQuotes: ['截至本报告出具日，公司注册资本为人民币1173.624万元。'],
        sourceQuality: 'visual_summary',
      },
    },
  ];
}

/** 客户归档规范：阶段 → 词条。歧义是数出来的，不是手写的。 */
export const NAMING_SPEC: Array<{ stage: BusinessStage; terms: string[] }> = [
  { stage: 'pre_initiation', terms: ['保密协议'] },
  { stage: 'initiation', terms: ['立项申请书', '立项报告', '立项评审纪要'] },
  { stage: 'due_diligence', terms: ['法律尽职调查报告', '财务尽职调查报告'] },
  {
    stage: 'investment_decision',
    terms: ['上会申请表', '投资建议书', '公司章程', '法律尽职调查报告', '投委会决议'],
  },
  {
    stage: 'investment_execution',
    terms: ['增资协议', '股东协议', '公司章程', '股东会决议', '交割确认函', '转账凭证'],
  },
  { stage: 'post_investment', terms: ['投后管理报告'] },
];

export function buildTermIndex(): Map<string, BusinessStage[]> {
  const index = new Map<string, BusinessStage[]>();
  for (const section of NAMING_SPEC) {
    for (const term of section.terms) {
      const stages = index.get(term);
      if (!stages) index.set(term, [section.stage]);
      else if (!stages.includes(section.stage)) stages.push(section.stage);
    }
  }
  return index;
}
