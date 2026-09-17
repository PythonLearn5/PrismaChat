# Prisma Review 修复实施计划

> **面向开发者说明：** 建议使用子代理驱动开发或计划执行子技能，按任务列表逐条落地。步骤使用复选框（`- [ ]`）标记进度。

**目标：** 恢复首次运行体验，让环境变量处理与文档保持一致，消除 OpenAI 兼容模型下附件静默丢失的问题，并把仓库重新拉回 TypeScript 类型检查全绿的干净状态。

**架构策略：** 行为改动保持小范围、局部化。在配置/环境变量、附件处理两条链路上先补一层纯函数测试基础设施（无副作用、可快速运行），再把测试通过的 helper 接入现有应用流；SDK 侧类型仅做与当前版本包一致的对齐与收窄，不引入额外抽象。

**技术栈：** React 19、TypeScript、Vite 6、Vitest、OpenAI SDK 6.x、@google/genai 1.x

---

## 深度思考（DeepThink）实现逻辑总览

深度思考系统位于 `services/deepThink` 目录，是 Prisma 中把一条用户消息变成高质量回复的核心管线。它不直接把请求丢给模型一次生成，而是把问题分解、并行专家求解、交叉审阅、综合收敛这四个阶段串成一条确定性流水线，利用多轮视角差异和多次「慢思考」换质量。

### 入口与调度器

| 组件 | 代码位置 | 职责 |
|------|----------|------|
| Orchestrator（主编排器） | [orchestrator.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/orchestrator.ts) | 管理整个生命周期：状态机切换、请求取消、并发队列、四阶段时序、错误兜底 |
| Manager（规划 / 评审引擎） | [manager.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/manager.ts) | Phase-1 把用户请求拆解成专家分工；Phase-3 做本轮专家结果的质量审阅并决定是否再迭代一轮 |
| Expert（专家执行器） | [expert.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/expert.ts) | 单一角色的流式推理执行，负责系统提示注入、thinking token 捕获、分段实时回写 |
| Synthesis（综合引擎） | [synthesis.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/synthesis.ts) | Phase-4 读入所有轮次所有专家的输出，做冲突鉴别、一致性归纳、最终答案生成 |
| Prompt 模板 | [prompts.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/prompts.ts) | Manager / Review / Expert / Synthesis 四段系统提示词的集中存放点，便于 A/B 调优 |
| 内容构造器 | [contentBuilder.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/contentBuilder.ts) | Google GenAI 与 OpenAI Chat 两种协议之间的附件、文本、图片多模态 payload 对齐层 |
| 协议分流客户端 | [openaiClient.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/openaiClient.ts) | OpenAI 兼容协议的非流式 / 流式双路径，统一消费 reasoning_content 与 `<thinking>` 两种思路格式 |

### 四阶段状态机与数据流

整个编排函数 [runDynamicDeepThinkOrchestration](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/orchestrator.ts#L157-L362) 内部按顺序驱动以下四段：

```
          ┌────────────────────────────────────────────────────────────────┐
          │  Phase 1 — Manager Analysis (规划拆解)                         │
          │                                                                │
          │   executeManagerAnalysis()                                    │
          │   ├─ 输入：query + 最近 5 条历史 + 附件                       │
          │   ├─ 协议分支：Google (responseSchema) vs OAI (json_object)  │
          │   ├─ 输出：{ thought_process, experts: [2..4] }               │
          │   └─ 失败兜底：空 experts 列表，只跑 Primary Responder         │
          └────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
          ┌────────────────────────────────────────────────────────────────┐
          │  Phase 2 — Expert Round 1 (并行专家求解)                       │
          │                                                                │
          │   Primary Expert (同步立即启动，不在队列中)                    │
          │   +                                                           │
          │   Manager 返回的 2~4 位补充专家（由 RequestQueue 控制并发）    │
          │                                                                │
          │   每位专家的生命周期 runExpertLifecycle()：                   │
          │     pending → thinking + 流式回写 content/thoughts → completed│
          │     或 → error（含友好 Configuration 提示）                    │
          │                                                                │
          │   常量：MAX_EXPERTS_PER_ROUND = 6                             │
          └────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
          ┌────────────────────────────────────────────────────────────────┐
          │  Phase 3 — Manager Review + 可选 Round N (交叉审阅 / 迭代)    │
          │                                                                │
          │   开关：config.enableRecursiveLoop && 至少有一位补充专家       │
          │   上限：MAX_ROUNDS = 2（防止无限循环）                         │
          │                                                                │
          │   executeManagerReview() 输入：query + 已完成专家输出         │
          │     输出 ReviewResult：{ satisfied, critique, refined_experts }│
          │                                                                │
          │     satisfied = true  → 跳出循环进入综合阶段                  │
          │     satisfied = false → 用带 critique 的 refined_experts 跑   │
          │                                  下一轮（通常会换角色或加约束） │
          └────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
          ┌────────────────────────────────────────────────────────────────┐
          │  Phase 4 — Synthesis (综合收敛)                                │
          │                                                                │
          │   streamSynthesisResponse()                                   │
          │   ├─ 输入：query + 最近上下文 + 全量 expertResults（含轮次）   │
          │   ├─ 综合提示词明确要求：识别冲突、追踪共识演进、不要机械总结   │
          │   └─ 输出：流式最终答案 + 综合过程 thoughts，由 bridge 写 UI   │
          │                                                                │
          │   失败兜底：若流式未产出任何正文且出错，用                      │
          │   formatSynthesisErrorMessage() 在正文位给出可操作排查建议     │
          └────────────────────────────────────────────────────────────────┘
```

### 与 UI 层的对接契约：DeepThinkRuntimeBridge

UI 层通过 [DeepThinkRuntimeBridge](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/orchestrator.ts#L23-L40) 接口，而不是直接消费内部 Promise，这使得 React 状态管理（useState/useRef）和调度器解耦：

| Bridge 方法 | 调用时机 |
|-------------|----------|
| `setAppState('analyzing' / 'experts_working' / 'reviewing' / 'synthesizing' / 'completed')` | 四阶段切换时 |
| `setManagerAnalysis` | Phase 1 拿到 thought_process + experts 后 |
| `setInitialExperts` / `appendExperts` | 专家列表创建时；每个新轮次会追加新的 expert-rN 卡片 |
| `updateExpertAt(index, partialPatch)` | **每一次**流式 chunk 到达都调用一次，用于实时渲染推理过程与输出 |
| `setFinalOutput` / `setSynthesisThoughts` | 综合阶段流式回写 |
| `setProcessStartTime / setProcessEndTime` | 记录总耗时，用于右上角「已思考 X 秒」UI |
| `queueRef.current.add(fn)` | 用 RequestQueue 限制并发，避免超量触发上游限流 |
| `abortControllerRef` | 用户下一条消息或点击「停止」时，AbortController 取消上一轮全部 in-flight 请求 |

### 双协议适配（Google GenAI vs OpenAI 兼容）

代码里任何需要发 LLM 请求的地方（Manager、Expert、Synthesis）都先通过 [isGoogleProvider](file:///d:/GITHUB_chat/PrismaChat/api.ts#L37-L44) 判定然后走两条分支：

| 维度 | Google 分支 | OpenAI 兼容分支 |
|------|-------------|-----------------|
| 入口函数 | `ai.models.generateContent` / `generateContentStream` | `generateContent` / `generateContentStream` in [openaiClient.ts](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/openaiClient.ts) |
| 结构化 JSON 约束 | `responseMimeType + responseSchema`（强类型、服务端校验） | `responseFormat: 'json_object'` + prompt 里手写 schema 注释 |
| Thinking token | chunk 中 `part.thought` 单独字段 | 两种格式统一：`reasoning_content`（SDK 原生字段）+ `<thinking>` 标签（DeepSeek/GLM 约定）由 [consumeThinkingContent](file:///d:/GITHUB_chat/PrismaChat/services/deepThink/openaiClient.ts#L63-L107) 状态机解析 |
| 附件构造 | `buildGoogleContents()` 统一 inlineData | `buildOpenAIContent()`：文本/代码转额外 text part，图片转 `image_url.data:` base64；PDF/视频/音频单独返回 unsupportedAttachments 供 UI 拦截提示 |

### 可配置的思考预算（Thinking Budget）

四个子阶段的 token 预算和温度不是写死的，而是从 `AppConfig` 的三个 `ThinkingLevel` 字段 [getThinkingBudget](file:///d:/GITHUB_chat/PrismaChat/config.ts#L186-L203) 映射得到：

```
planningLevel   →  Phase 1 / 3 Manager （规划 & 评审）
expertLevel     →  Phase 2    Expert  （每位专家共用）
synthesisLevel  →  Phase 4    Synthesis（综合）
```

再加上 `expertConcurrency` 控制 RequestQueue 并行上限、`enableRecursiveLoop` 控制是否进入 Round 2——用户在 UI 设置里可以在「保守经济（低）」与「深度强推理（高）」之间做滑动权衡。

---

## 任务 1：搭建回归测试脚手架

**涉及文件：**

- 修改：`package.json`
- 新建：`tests/config.test.ts`
- 新建：`tests/contentBuilder.test.ts`

- [ ] **步骤 1：先写失败测试**
- [ ] **步骤 2：执行测试，确认它们确实以预期的方式失败（红）**
- [ ] **步骤 3：补上最小必要的测试脚本与 devDependency 支撑**
- [ ] **步骤 4：重跑这两份针对性测试**

## 任务 2：修复启动默认值与环境变量键位兼容性

**涉及文件：**

- 修改：`hooks/useAppLogic.ts`
- 修改：`api.ts`
- 修改：`vite-env.d.ts`
- 修改：`README.md`
- 测试：`tests/config.test.ts`

- [ ] **步骤 1：为「初始模型选中策略」和「env 回退路径」写失败断言**
- [ ] **步骤 2：跑针对性测试，看到失败**
- [ ] **步骤 3：用最小改动实现 helper，并接入现有应用流**
- [ ] **步骤 4：重跑针对性测试，断言变绿**

## 任务 3：修复 OpenAI 兼容协议下的附件行为

**涉及文件：**

- 修改：`services/deepThink/contentBuilder.ts`
- 修改：`components/ChatInput.tsx`
- 修改：`App.tsx`
- 修改：`hooks/useAppLogic.ts`
- 测试：`tests/contentBuilder.test.ts`

- [ ] **步骤 1：为「文本/代码附件内联行为」与「不支持附件检测」写失败断言**
- [ ] **步骤 2：跑针对性测试，看到失败**
- [ ] **步骤 3：实现附件转文本块；在 UI 侧对 PDF / 视频 / 音频等协议不支持类型做提交拦截 + 表层错误回显**
- [ ] **步骤 4：重跑针对性测试，断言变绿**

## 任务 4：恢复类型检查全绿

**涉及文件：**

- 修改：`api.ts`
- 修改：`services/deepThink/openaiClient.ts`
- 修改：`services/deepThink/expert.ts`
- 修改：`services/deepThink/manager.ts`
- 修改：`services/deepThink/synthesis.ts`
- 修改：`services/deepThink/contentBuilder.ts`
- 修改：`components/Sidebar.tsx`

- [ ] **步骤 1：跑 `npx tsc --noEmit`，把当前错误列表记下来**
- [ ] **步骤 2：把 SDK 侧类型签名、类型收窄语句对齐到目前版本包的真实 API**
- [ ] **步骤 3：反复 `npx tsc --noEmit` 直到 0 error**

## 任务 5：最终回归验证

**涉及文件：**

- 修改：`package.json`（如果任务 1 需要脚本或依赖）

- [ ] **步骤 1：跑两份针对性测试**
- [ ] **步骤 2：跑 `npx tsc --noEmit`**
- [ ] **步骤 3：跑 `npm run lint`**
- [ ] **步骤 4：跑 `npm run build`**
