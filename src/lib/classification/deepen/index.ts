import { runDeepenGraph } from './graph';
import { runDeepenLoop } from './loop';
import { defaultDeps, defaultOrchestrator, type DeepenDeps } from './shared';
import type { DeepenParams, DeepenResult } from './types';

/**
 * 深挖旁路的入口。
 *
 * 判不出来的时候，自己去查一轮再判。**这是整个项目里唯一一处真正的 agent**——步数
 * 不定、路径由中间结果决定、终止条件自己判。主链路不是（步骤固定）。
 *
 * 三条边界（见 docs/DEEPEN_AGENT_PLAN.md 第 3 节）：
 *
 * - **只取证，不判阶段。** 循环结束后把凑齐的事实交回 `decideStageWithModel`，
 *   判断权仍然只有一个出口。不这么做的话，系统里会出现第二个判据来源——
 *   上一次架构失败正是判断权跑到了覆盖面最窄的组件手里。
 * - **只读不写。** 深挖抽到的新事实不写回项目档案。
 * - **默认开启，可显式关闭。** 真正的闸门是工具清单和判定器，不是那个开关。
 *
 * 编排有两套实现，用哪套由 `params.orchestrator` 或 `DEEPEN_ORCHESTRATOR` 决定，
 * **缺省是手写循环**——它是线上跑过的那套，换默认值要有实测依据。
 */
export async function runDeepen(
  params: DeepenParams,
  deps: DeepenDeps = defaultDeps
): Promise<DeepenResult> {
  const orchestrator = params.orchestrator ?? defaultOrchestrator();
  return orchestrator === 'graph'
    ? runDeepenGraph(params, deps)
    : runDeepenLoop(params, deps);
}

export {
  defaultOrchestrator,
  describeDeepenFlag,
  isDeepenEnabled,
  type DeepenDeps,
} from './shared';
export { runDeepenGraph } from './graph';
export { runDeepenLoop } from './loop';
