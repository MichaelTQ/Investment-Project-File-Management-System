# 深挖旁路：一个真正需要 Agent 的地方

状态：方案｜2026-08-08
定位：**学习性质的独立旁路**，默认关闭，不进入 `/api/classify` 主链路。

---

## 1. 为什么是这里，而不是别处

`docs/RETIRED_AGENT_ARCHITECTURE.md` 记着上一次的教训：那套 LangGraph 编排的
`llmCallCount` 恒为 0，五个节点没有一个在做判断。它失败的原因不是 LangGraph，是
**被编排的那件事本身步骤固定**——读文件、抽事实、比对、给结论，顺序永远一样，
不需要谁在运行时决定下一步干什么。给固定流程套 agent，只会得到一张更贵的流程图。

深挖不一样。它的输入是一句话：

> "缺一份记载资本变更的股东会决议。"

这句话是**任务描述，不是流程**。要读哪几份文件事先不知道；读了第一份可能才发现该读
第二份（决议里写着"根据第三次投委会决议"，于是要去找那份）；什么时候算证据够了、
什么时候该老实说找不到，得在运行中判断。步数不定、路径由中间结果决定、终止条件要
自己判——这三条同时成立，才是 agent 该干的活。

主链路一条都不占，深挖三条全占。

## 2. 现在的代码已经把口子留好了

不需要新建触发机制，`rebuildMinimalArchive` 返回的报告里已经有两处：

| 入口 | 现状 | 出自 |
|---|---|---|
| `deepenSuggestions` | 已标出"值得深挖的文件"和原因，注释写着**系统只标记，不自动执行** | [rule-checks.ts:139](src/lib/classification/minimal/rule-checks.ts:139) |
| `status: 'insufficient'` | 判不出来的文件，带着"缺什么"的说明 | [types.ts](src/lib/classification/minimal/types.ts) |

`suggestDocumentsToDeepen` 挑出来的正是那批 `sourceQuality === 'filename_only'`
的文件——**内容压根没读过**。它们判不准不是因为模型不行，是因为没人愿意为一份看起来
正常的扫描件付一次视觉模型调用的钱。

深挖旁路要做的，就是在这批文件里**自己决定该为哪几份付这个钱**。

## 3. 边界：只取证，不判阶段

这是整个方案最要紧的一条。

**Agent 负责把证据凑齐，凑齐之后仍然交给现有的 `decideStageWithModel` 出结论。**

不让 agent 自己下结论，有三个理由：

1. **不制造第二个判据出口。** 上次的教训是判断权跑到了覆盖面最窄的组件手里。判定器
   只能有一个，新增的层只能改变它看到的输入，不能替它说话。
2. **评测能干净地做减法。** 同一个判定器、同一份文件，唯一变量是"深挖前 vs 深挖后
   的事实"。救回几份、判错几份，一目了然。
3. **符合原则一。** 深挖只往上加事实，加不出来就退回原状，挡不了任何路。

对应的工程约束：**agent 全程只读不写**。不动 `minimal-archive` 的归档阶段，不动
任何文件位置。产出是一份 proposal，照旧进人工确认。

## 4. 工具清单

五个工具，四个便宜、一个贵。贵的那个就是预算的全部意义。

| 工具 | 干什么 | 底层 | 成本 |
|---|---|---|---|
| `list_project_documents` | 列出本项目所有文件：路径、类型、当前阶段、阶段是谁定的、内容读没读过 | `loadMinimalArchive` | 0 |
| `read_document_facts` | 取某份文件**已存**的事实 | 同上，内存过滤 | 0 |
| `get_timeline` | 全项目日期时间线 | `buildTimeline` + `describeTimeline` | 0 |
| `match_naming_spec` | 拿文件名去对客户自己写的归档规范 | `matchSpecTerm` | 0 |
| **`extract_document_facts`** | **真去读一份文件**：本地取文本 → 无文字层则走 OCR/视觉 → 抽事实 | `extractDocumentFacts` | **1–2 次模型调用 + 数秒** |

第 5 个是唯一会花钱的，也是 agent 真正在做的那个决策：**这份值不值得读。**

`list_project_documents` 必须把 `stageSource` 一并返回。人工确认过的位置和纯按命名
规范落位的位置，可信度差一个数量级，[evidence.ts](src/lib/classification/minimal/evidence.ts)
里对这个区分写得很清楚，深挖这边不能丢。

### 一处需要先重构

文件内容的获取逻辑（本地 PDF 取文本 → 判断文字层 → 降级 OCR/视觉）现在是内联在
[classify/route.ts](src/app/api/classify/route.ts) 的 490–660 行里的。深挖要复用它，
得先抽成 `src/lib/classification/read-document-content.ts`。**纯搬运，不改行为**，
主链路调用点同步替换。这是动手第一步。

## 5. 循环边界

```
预算：extract 最多 3 次，工具调用最多 12 轮，墙钟 90 秒
```

三个都是硬上限，任一触顶立即停，**停下时必须说清还差什么**——"证据不足"是废话，
"缺一份记载 11.73624 → 13.04027 的股东会决议"才是能派活给人的信息。这条是原则三。

`extract` 定 3 次，是因为君柔那对章程的实测里，钉死它们需要的是"两份章程 + 一份决议"，
第三次已经是余量。上不封顶的话，第一版一定会出现读了 15 份文件、花了两分钟、结论
和读 2 份时一样的情况。

### 提示词里必须写死的两条

- **打印时间、OA 截图时间不是文件形成时间。** 君柔那批 PDF 的打印时间戳会伪造出
  根本不存在的时序矛盾，agent 一旦拿它当日期证据，会顺着假线索一路挖下去。
- **不许凭文件类型猜阶段。** "缴款通知书通常属于投资实施"这类结论写进提示词，就是
  把删掉的关键词表用自然语言重新种回去。要判断，得指着原文里的数字或措辞说。

## 6. 用什么写

**手写 tool loop，复用现有的 `invokeChatCompletion`。不引框架。**

现在所有模型调用都走 [chat-completions.ts](src/lib/classification/chat-completions.ts)
打到 Coze 上的 doubao，它是 OpenAI 兼容接口，function calling 直接可用。要做的是给
`invokeChatCompletion` 加上 `tools` 参数和 `tool_calls` 的回传，然后写这个循环：

```
messages = [system, user任务描述]
loop:
  response = 调模型(messages, tools)
  如果没有 tool_calls → 跳出，这是最终答复
  对每个 tool_call：执行、把结果作为 tool 消息追加
  预算检查：超了就追加一条"预算已用尽，请给出目前结论和还缺什么"，再跑最后一轮
```

正文大约 60 行。

之所以推荐手写而不是上 LangGraph / Agent SDK：agent 的内核就是这个循环，四十行看完
就没有秘密了。先把它写出来跑通，之后再评估任何框架，你都清楚它替你做了什么、以及
是不是值得。上一次装了 `@langchain/langgraph` 结果编排层零模型调用，正是因为框架的
结构感掩盖了"这里其实没有决策"这个事实。

### 用 `openai` 这个包，不是用 OpenAI

已装 `openai@7.4.0`，`baseURL` 指向现有的 Coze 网关。请求不经过 OpenAI 任何机器，
不需要 OpenAI 账号或密钥——这个包只是 OpenAI 定的那套接口格式的客户端，而豆包网关
兼容那套格式。

它替我们做掉的关键一件事：**把流式分片吐出来的 `tool_calls` 拼回完整 JSON**。工具名
和参数是一个字符一个字符流回来的，要按 index 归并——手写这段最容易出错。
`client.chat.completions.stream()` + `finalChatCompletion()` 直接给完整消息。

必须走流式：**网关一律以 SSE 返回，即使没要求流式**（`scripts/probe-model.mjs` 里
记着这个坑）。

## 6.5 实测：function calling 可用（2026-08-09）

`scripts/probe-tool-calling.mjs`——挂一个工具、喂假文件清单，验证模型会不会主动要工具。

| 项 | 实测值 |
|---|---|
| 模型 | `doubao-seed-2-0-mini-260215`（**最便宜那个就够**，不必上 pro） |
| 网关 | `https://integration.coze.cn/api/v3`，透传 `tools` 正常 |
| `finish_reason` | 第 1 轮 `tool_calls`，第 2 轮 `stop` |
| 耗时 | 1204ms + 2557ms，两轮共约 3.8 秒 |
| 结论 | 主动请求 1 次工具调用，判断内容正确命中两份同名章程 |

三点推论：

1. **循环调度用 mini 即可。** "下一步该干什么"这个决策不需要判阶段那个贵模型；花钱
   的地方应该是 `extract_document_facts`（读扫描件），不是编排。
2. **第 9 节的预算给宽了但先留着。** 循环本身几秒钟，90 秒墙钟的实际消耗几乎全在 OCR
   和视觉调用上。等真工具挂上去再按实测收紧。
3. **多轮链式取证还没验证。** 本次只挂了一个工具，模型看完清单就无事可做，停在第 2 轮
   是正确行为。"读完章程发现还得去找股东会决议"这种链式行为，要等
   `extract_document_facts` 挂上才测得到——那是下一步的重点，也是整个方案真正的赌注。

轻微瑕疵：答复末尾有凑字数倾向（"其余文件本质上也都有这个问题"）。挂真工具后若仍如此，
提示词加一句简洁性约束即可，暂不处理。

## 7. 接口与开关

```
新增  src/lib/classification/deepen/{agent.ts, tools.ts, types.ts}
新增  src/lib/classification/read-document-content.ts   （从 classify 路由抽出）
新增  POST /api/deepen  { projectId, sourcePath }
改动  invokeChatCompletion 支持 tools / tool_calls
改动  前端：rebuild 报告里每条 deepenSuggestion 加「深挖这份」按钮
开关  ENABLE_DEEPEN_AGENT，默认关
```

`/api/deepen` 的返回除了新结论，还要带**完整执行轨迹**：调了哪些工具、读了哪几份
文件、每步花多少。这不只是调试用——学 agent 开发，看轨迹的时间会比看代码多。

## 8. 怎么算成功

靶子现成：君柔 35 份 + 6 个金标准 + 已有的 shadow 评测基线（明确建议 6 份、6/6 命中、
错误自主建议 0）。

| 指标 | 含义 | 及格线 |
|---|---|---|
| **救回率** | 深挖前 `insufficient`、深挖后判对 | 越高越好，首版有几份就算数 |
| **新增错误** | 深挖前 `insufficient`、深挖后判错 | **必须为 0** |
| 平均调用数 | 每次深挖的模型调用次数 | ≤ 4 |
| 平均耗时 | 墙钟 | ≤ 60 秒 |

新增错误必须为 0，是因为确认时下拉框的默认值就是系统建议，一路点确认的话错误建议
会直接变成错误归档。**判不出来的代价是把活推还给人，判错的代价是悄悄错掉。**
深挖救不回来可以接受，救错不行。

## 9. 动手顺序

1. 抽出 `read-document-content.ts`，主链路替换，跑通现有测试 —— 纯重构，风险为零
2. ~~最小 loop，只挂一个工具，验证模型会不会主动要工具~~ ✅ **已完成 2026-08-09**，
   见第 6.5 节。实现落在 `scripts/probe-tool-calling.mjs`，用 `openai` SDK 而非改
   `invokeChatCompletion`——现有那条链路服务主流程，不必为旁路动它。
3. 补齐其余四个工具 + 预算控制 + 轨迹记录
4. 接 `/api/deepen`，前端加按钮
5. 拿君柔 35 份跑评测，填第 8 节的表

第 2 步是分水岭，前面是搬砖，后面是调提示词和边界。**第 3 步才验证真正的赌注**——
多轮链式取证（读完 A 才知道要读 B）。那个不成立的话，深挖相对于"一次性把所有事实
喂给模型"就没有额外价值。
