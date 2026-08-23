/**
 * 取证 Agent 的类型与预算。
 *
 * 与生产实现 (src/lib/classification/deepen/types.ts) 保持同名同值——这个 demo 的
 * 意义就是"同一套边界，换一种编排方式实现"，数字对不上就失去了对照价值。
 */

/** 三个硬上限，任一触顶立即停，并要求模型说清还缺什么。 */
export const BUDGET = {
  /** 唯一花钱的动作：读一份扫描件要一次视觉模型调用。 */
  maxExtracts: 3,
  maxRounds: 12,
  wallClockMs: 90_000,
} as const;

export type StopReason =
  /** 模型自己认为取证够了 */
  | 'completed'
  /** 读取次数用尽 */
  | 'extract_budget'
  /** 轮数用尽 */
  | 'round_budget'
  /** 墙钟超时 */
  | 'timeout'
  /** 出错中断 */
  | 'error';

export type BusinessStage =
  | 'pre_initiation'
  | 'initiation'
  | 'due_diligence'
  | 'investment_decision'
  | 'investment_execution'
  | 'post_investment'
  | 'exit_decision'
  | 'exit_execution';

export const STAGE_LABEL: Record<BusinessStage, string> = {
  pre_initiation: '立项前',
  initiation: '项目立项',
  due_diligence: '尽职调查',
  investment_decision: '投资决策',
  investment_execution: '投资实施',
  post_investment: '投后管理',
  exit_decision: '退出决策',
  exit_execution: '退出执行',
};

export interface TransactionChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface DocFacts {
  documentType: string;
  title: string;
  dates: Array<{ meaning: string; date: string }>;
  parties: Array<{ name: string; role: string }>;
  transactionChanges: TransactionChange[];
  evidenceQuotes: string[];
  /** text = 有文字层；visual_summary = 走了 OCR；filename_only = 没读过内容 */
  sourceQuality: 'text' | 'visual_summary' | 'filename_only';
}

export interface ProjectDoc {
  sourcePath: string;
  stage: BusinessStage | null;
  /** 这个阶段是人工确认的，还是仅按文件名规则落的。 */
  stageSource: 'human' | 'naming_rule' | null;
  /** 内容读过没有。false 时 facts 只是文件名占位。 */
  contentRead: boolean;
  facts: DocFacts;
  /**
   * 只有调用 extract_document_facts 才会揭开的事实。
   * 用来模拟"读一份扫描件要花钱"——不读就真的看不到这些内容。
   */
  hiddenFacts?: DocFacts;
}

export interface ToolCallRecord {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  brief: string;
  isError: boolean;
  durationMs: number;
}
