/**
 * 兼容层。
 *
 * 深挖原先是这一个文件，拆成 shared / loop / graph / index 之后，入口搬到了
 * `./index`。这里保留原来的导出名，免得 route、测试和前端全都要改 import——
 * 它们要的东西一个都没变。
 */
export {
  defaultOrchestrator,
  describeDeepenFlag,
  isDeepenEnabled,
  runDeepen,
  runDeepenGraph,
  runDeepenLoop,
  type DeepenDeps,
} from './index';
