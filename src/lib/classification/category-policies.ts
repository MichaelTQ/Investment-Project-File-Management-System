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

export const CATEGORY_EVIDENCE_POLICIES: CategoryEvidencePolicy[] = [
  INVESTMENT_COMPLIANCE_REVIEW_POLICY,
];

export function getCategoryEvidencePolicy(
  folderId: string,
  fileName: string
): CategoryEvidencePolicy | undefined {
  return CATEGORY_EVIDENCE_POLICIES.find(
    policy => policy.folderId === folderId && policy.fileName === fileName
  );
}
