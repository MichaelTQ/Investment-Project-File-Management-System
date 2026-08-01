export interface CategoryEvidencePolicy {
  categoryKey: string;
  folderId: string;
  fileName: string;
  documentTypes: string[];
  applicableStages: string[];
  requiredEvidenceAny: string[];
  positiveEvidence: string[];
  negativeEvidence: string[];
  defaultRequiresHumanReview: boolean;
  policyVersion: string;
}

export const INVESTMENT_COMPLIANCE_REVIEW_POLICY: CategoryEvidencePolicy = {
  categoryKey: 'decision-meeting:投资合规性审查表',
  folderId: 'decision-meeting',
  fileName: '投资合规性审查表',
  documentTypes: ['investment_compliance_review'],
  applicableStages: ['investment_decision'],
  requiredEvidenceAny: [
    '文件正式标题明确为投资项目合规性审查表或同义名称',
    '正文包含子基金管理人针对具体投资项目出具的合规审查意见',
  ],
  positiveEvidence: [
    '文件包含拟投资项目、投资金额、估值或持股比例等投资方案',
    '文件逐项检查基金投资范围、投资限制、关联交易或禁止事项',
    '文件包含子基金管理人意见、审核结论、签章或审核日期',
    '文件形成于投资实施付款之前，用于支持投资决策或审批',
  ],
  negativeEvidence: [
    '文件只是目标公司的法律尽职调查报告或律师法律意见书',
    '文件只是投后合规检查、风险排查或整改报告',
    '文件只有一般性合规表述，没有针对具体投资项目的审查结论',
    '文件只是投资建议书，没有独立的合规审查结构或管理人意见',
  ],
  defaultRequiresHumanReview: true,
  policyVersion: 'investment-compliance-review-v1',
};

export const SHAREHOLDER_RESOLUTION_POLICY: CategoryEvidencePolicy = {
  categoryKey: 'investment-implementation:股东会决议',
  folderId: 'investment-implementation',
  fileName: '股东会决议',
  documentTypes: ['shareholder_resolution'],
  applicableStages: ['investment_execution'],
  requiredEvidenceAny: [
    '文件正式标题明确为目标公司股东会决议',
    '正文批准增资、交易文件、股权结构变化或修改公司章程',
  ],
  positiveEvidence: [
    '决议批准新增注册资本、投资方入股或增资后股东结构',
    '决议同意签署增资协议、股东协议或加入协议',
    '项目事件将该决议直接关联到投资实施阶段',
  ],
  negativeEvidence: [
    '文件实际为基金投资决策委员会或投委会决议',
    '文件仅讨论是否投资，未形成目标公司股东层面的交易批准',
  ],
  defaultRequiresHumanReview: false,
  policyVersion: 'shareholder-resolution-v1',
};

export const CLOSING_CONFIRMATION_POLICY: CategoryEvidencePolicy = {
  categoryKey: 'investment-implementation:确权文件',
  folderId: 'investment-implementation',
  fileName: '确权文件',
  documentTypes: ['closing_confirmation'],
  applicableStages: ['investment_execution'],
  requiredEvidenceAny: [
    '文件正式标题明确为交割确认函、交割证明书或同义名称',
    '正文确认投资协议项下交割条件已经满足或被豁免',
  ],
  positiveEvidence: [
    '文件引用已经签署的增资协议或投资协议',
    '文件确认交割先决条件、陈述保证或交割义务',
    '项目事件将文件关联到交割条件确认',
  ],
  negativeEvidence: [
    '文件只是要求付款的缴款通知书',
    '文件只是银行回单、转账凭证或付款证明',
    '文件描述的是项目退出交割而非投资实施交割',
  ],
  defaultRequiresHumanReview: false,
  policyVersion: 'closing-confirmation-v1',
};

export const PAYMENT_NOTICE_POLICY: CategoryEvidencePolicy = {
  categoryKey: 'investment-implementation:付款通知函',
  folderId: 'investment-implementation',
  fileName: '付款通知函',
  documentTypes: ['payment_notice'],
  applicableStages: ['investment_execution'],
  requiredEvidenceAny: [
    '文件正式标题明确为缴款通知书、付款通知函或同义名称',
    '正文要求投资方按照交易协议支付投资款或增资款',
  ],
  positiveEvidence: [
    '文件列明付款主体、金额、期限或收款账户',
    '文件引用增资协议、加入协议或交割条件',
    '项目事件将文件关联到交割条件确认或缴款通知',
  ],
  negativeEvidence: [
    '文件是付款完成后的银行回单或转账凭证',
    '文件是项目退出阶段的付款安排',
    '文件只有一般交易条款，没有付款通知结构',
  ],
  defaultRequiresHumanReview: false,
  policyVersion: 'payment-notice-v1',
};

export const CATEGORY_EVIDENCE_POLICIES: CategoryEvidencePolicy[] = [
  INVESTMENT_COMPLIANCE_REVIEW_POLICY,
  SHAREHOLDER_RESOLUTION_POLICY,
  CLOSING_CONFIRMATION_POLICY,
  PAYMENT_NOTICE_POLICY,
];

export function getCategoryEvidencePolicy(
  folderId: string,
  fileName: string
): CategoryEvidencePolicy | undefined {
  return CATEGORY_EVIDENCE_POLICIES.find(
    policy => policy.folderId === folderId && policy.fileName === fileName
  );
}
