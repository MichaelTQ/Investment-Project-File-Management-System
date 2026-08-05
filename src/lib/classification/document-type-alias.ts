import type { DocumentType } from './document-facts';

/**
 * 把模型写下的中文类型名（rawDocumentType）对回枚举值。
 *
 * 实测中抽取模型经常一边正确读出内容——标题写着"股东会决议"、正文抽出了
 * "注册资本由 11.73624 万元增加至 13.04027 万元"——一边把 documentType 填成
 * unknown。类型一旦是 unknown，这份文件就当不了交易锚点，下游只能退回倾向性
 * 推测，把握程度从 85 掉到 45。
 *
 * 这一步只做一件事：读模型自己写的中文类型，翻译成枚举值。**不看文件名**，
 * 也不看正文——文件名猜类型是明令禁止的（见 fact-extractor 的
 * enforceContentEvidence），这里翻译的是模型已经给出的判断，不是新的推断。
 *
 * 顺序有意义：长的、专指的写法排在前面，"股东会决议"必须先于"决议"命中。
 */
const TYPE_ALIASES: Array<[string, DocumentType]> = [
  ['投资决策委员会决议', 'investment_committee_resolution'],
  ['投资决策委员会决定', 'investment_committee_resolution'],
  ['投委会决议', 'investment_committee_resolution'],
  ['投委会决定', 'investment_committee_resolution'],
  ['股东会决议', 'shareholder_resolution'],
  ['股东会决定', 'shareholder_resolution'],
  ['股东决定', 'shareholder_resolution'],
  ['股东决议', 'shareholder_resolution'],
  ['董事会决议', 'board_resolution'],
  ['董事会决定', 'board_resolution'],
  ['增资扩股协议', 'capital_increase_agreement'],
  ['增资协议', 'capital_increase_agreement'],
  ['投资协议', 'capital_increase_agreement'],
  ['股东协议', 'shareholder_agreement'],
  ['公司章程', 'company_charter'],
  ['章程修正案', 'company_charter'],
  ['章程', 'company_charter'],
  ['营业执照', 'business_license'],
  ['缴款通知书', 'payment_notice'],
  ['缴款通知', 'payment_notice'],
  ['出资通知书', 'payment_notice'],
  ['交割确认函', 'closing_confirmation'],
  ['交割确认书', 'closing_confirmation'],
  ['出资证明书', 'capital_contribution_certificate'],
  ['股东名册', 'shareholder_register'],
  ['银行回单', 'bank_receipt'],
  ['电子回单', 'bank_receipt'],
  ['进账单', 'bank_receipt'],
  ['尽职调查报告', 'due_diligence_report'],
  ['尽调报告', 'due_diligence_report'],
  ['商业计划书', 'business_plan'],
  ['立项报告', 'project_initiation_report'],
  ['立项申请', 'project_initiation_application'],
  ['投资建议书', 'investment_recommendation'],
  ['投资合规性审查表', 'investment_compliance_review'],
  ['合规性审查', 'investment_compliance_review'],
  ['会议纪要', 'meeting_minutes'],
  ['表决结果', 'voting_result'],
  ['表决票', 'voting_result'],
  ['审计报告', 'financial_statement'],
  ['资产负债表', 'financial_statement'],
  ['利润表', 'financial_statement'],
  ['财务报表', 'financial_statement'],
  ['信用报告', 'credit_report'],
  ['保密协议', 'confidentiality_agreement'],
];

/**
 * 模型写的中文类型能对上枚举值就返回，对不上返回 null。
 * 返回 null 时保持 unknown——宁可不判，也不硬凑一个类型。
 */
export function documentTypeFromRawLabel(
  rawDocumentType: string
): DocumentType | null {
  const label = rawDocumentType.replace(/\s|[（(][^）)]*[）)]/g, '');
  if (!label || label === '未知') return null;

  for (const [alias, documentType] of TYPE_ALIASES) {
    if (label.includes(alias)) return documentType;
  }
  return null;
}
