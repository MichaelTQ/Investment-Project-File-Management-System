import type {
  ArchiveBusinessStage,
  ArchiveFolder,
} from '../../folder-structure';

/**
 * 阶段判断的结果结构。
 *
 * 原先这里还有 stageConfidence、confidence、candidates、routingMethod 等字段，
 * 用来承载代码推导出的把握程度和候选打分。那套档位（85/65/45/25 对应证据强度）
 * 本身就是预设，已随锚点逻辑一并删除：现在没有任何分数，结论要么给出阶段，
 * 要么如实说判不出来。
 */
export interface ContextClassificationDecision {
  status: 'decided' | 'insufficient';
  selectedFolder: ArchiveFolder | null;
  /** 判不出来时为 null。不用 'unknown' 占位——归档目录里没有这个阶段。 */
  businessStage: ArchiveBusinessStage | null;
  evidence: string[];
  contradictions: string[];
  requiresHumanReview: boolean;
  reasoning: string;
  policyVersion: string;
}
