import type { ArchiveBusinessStage, ArchiveFolder } from '../../folder-structure';
import type { ModelCallDiagnostics } from '../chat-completions';

/**
 * 深挖旁路的类型与预算。
 *
 * 方案见 docs/DEEPEN_AGENT_PLAN.md。三条边界在这里落成类型约束：
 *
 * 1. **只取证，不判阶段。** 本模块不产出 businessStage——凑齐事实之后交回
 *    `decideStageWithModel`，判断权仍然只有一个出口。见 {@link DeepenResult.decision}。
 * 2. **只读不写。** 深挖过程中抽到的新事实**不写回项目档案**，只在本次会话内使用。
 *    写入必须走用户确认过的正常归档流程。
 * 3. **默认关闭。** 由 ENABLE_DEEPEN_AGENT 控制，见 agent.ts。
 */

/** 编排用的模型。实测 mini 就能挑对文件（第 6.6 节），没必要上 pro。 */
export const DEEPEN_MODEL =
  globalThis.process.env.DEEPEN_MODEL?.trim() || 'doubao-seed-2-0-mini-260215';

/**
 * 预算。三个都是硬上限，任一触顶立即停，并要求模型说清还缺什么。
 *
 * MAX_EXTRACTS 是唯一花钱的那个动作的上限——读一份扫描件要一次视觉模型调用。
 * 定 3 是因为君柔那对章程实测需要"两份章程 + 一份决议"，第三次已是余量。
 * 上不封顶的话，第一版一定会出现读了 15 份、花两分钟、结论和读 2 份时一样的情况。
 */
export const DEEPEN_BUDGET = {
  maxExtracts: 3,
  maxRounds: 12,
  wallClockMs: 90_000,
} as const;

/** 单次工具调用的记录。轨迹是这条链路的主要产出之一——调试和学习都靠它。 */
export interface DeepenToolCall {
  round: number;
  tool: string;
  /** 模型给的原始参数字符串。解析失败时也原样留着，便于排查。 */
  rawArguments: string;
  /** 结果摘要，不是全文——全文可能上千字，轨迹会没法看。 */
  resultBrief: string;
  durationMs: number;
  isError: boolean;
}

export interface DeepenTraceRound {
  round: number;
  /** 模型这一轮说的话。可能为空——它经常直接发工具调用不说话。 */
  message: string;
  toolCalls: DeepenToolCall[];
  durationMs: number;
  finishReason: string | null;
}

/** 停止原因。区分"想清楚了"和"被预算掐断"，评测时这两者不能混。 */
export type DeepenStopReason =
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

export interface DeepenParams {
  projectId: string;
  /** 要深挖的那份文件。 */
  sourcePath: string;
  projectName?: string;
  /** 项目负责人填写的归档口径，透传给判定器。 */
  projectNotes?: string;
  /** 命名规范给出的候选阶段，软提示，透传给判定器。 */
  namingHint?: { term: string; stages: ArchiveBusinessStage[] };
  customHeaders?: Record<string, string>;
}

export interface DeepenResult {
  sourcePath: string;
  /**
   * 最终结论。**由 `decideStageWithModel` 产出，不是本模块自己判的。**
   *
   * null 表示取证阶段就失败了（目标文件不存在、模型调用出错等），
   * 这种情况下 `error` 会说明原因。
   */
  decision: {
    stage: ArchiveBusinessStage | null;
    folder: ArchiveFolder | null;
    reasoning: string;
    evidence: string[];
    contradictions: string[];
    requiresHumanReview: boolean;
  } | null;
  /** 深挖过程中读到的新事实，按文件名索引。**不写回档案**，仅供本次展示。 */
  gatheredFacts: Array<{ sourcePath: string; round: number }>;
  stopReason: DeepenStopReason;
  /** 停下来时模型自己的说明——尤其是"还缺一份记载什么的文件"。 */
  closingNote: string;
  trace: DeepenTraceRound[];
  extractCount: number;
  roundCount: number;
  totalDurationMs: number;
  modelCalls: ModelCallDiagnostics[];
  error?: string;
}
