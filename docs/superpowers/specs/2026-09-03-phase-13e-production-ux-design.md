# Caelush Phase 13E Production UX Design

> USER-APPROVED DESIGN

## Goal

把 Phase 13A–13D 已存在的真实 Session、Conversation、Agent Timeline、Approval、Cancellation、Reconnect、Recovery 和 Verification 能力组织成一个可长期使用的 Production Web Host。Phase 13E 只改善 Web 信息架构、视觉层级、交互状态、响应式与发布验证，不扩大后端业务能力。

## Frozen information architecture

桌面 Web 只有两列：

1. 顶部 Top Bar：Caelush、当前 Workspace、daemon connection state。
2. 左侧 Session Sidebar：`+ 新建会话` 与 Session List。
3. 右侧 Main Agent Workspace：Conversation、inline Agent Activity/Timeline、inline controls、Composer。

不加入 Right Inspector、Bottom Status Bar、Settings/Help/MCP/Tools/Context/Models/RAG/Attachments/Usage/File Browser/Git/Terminal 或任何没有公开业务契约支撑的面板。Top Bar 不重复 `New Session`。

## Session Sidebar

每个 Session Row 是单行 `status icon + title`。标题使用现有 `latest Run.goal` / Session title 投影并保持 bounded、ellipsis；selected 使用轻微背景，hover 使用轻量反馈。Row 不显示第二行状态、副标题、Run ID、时间、Model、Token 或 Workspace。

状态仍完全来自真实 `latest Run.status`，只改变视觉表达：

| Run status | Visual mark | Accessible label |
| --- | --- | --- |
| `PENDING` | pending mark | 准备中 |
| `RUNNING` | activity mark | 运行中 |
| `WAITING_APPROVAL` | warning mark | 等待审批 |
| `VERIFYING` | verification/spinner mark | 验证中 |
| `COMPLETED` | check mark | 已完成 |
| `FAILED` | error mark | 失败 |
| `CANCELLED` | cancelled mark | 已取消 |
| `TIMEOUT` | timeout mark | 已超时 |
| `MAX_STEPS_REACHED` | stopped mark | 已达到步骤上限 |
| `BUDGET_EXCEEDED` | limit mark | 已超出预算 |

Icon 必须有 `aria-label` 或等价 accessible name；可使用 tooltip，但 tooltip 不是第二行布局。空状态只保留新建会话操作和简洁欢迎文案。

## Main Agent Workspace

Conversation 与 Agent Activity 是同一个工作区流，不拆成聊天区与日志控制台。历史只渲染真实 Session history；Timeline 只渲染真实 `TimelineState`；Verified Result 只在真实 `COMPLETED` + `VerifiedRunFinalResult` 存在时出现。Goal 不在 Timeline 再重复一次。

Timeline 使用高信息密度的 `mark + title + secondary detail`：

- Reasoning 只显示公开的简短 `推理摘要`，绝不显示 hidden reasoning、raw provider reasoning 或 system prompt；连续摘要可轻量折叠。
- Tool/File 只显示公开 tool label、workspace-relative file path、change type 与 bounded additions/deletions。
- Shell/Process 只显示安全 command label、exit status、process status；不显示 stdout、stderr、terminal 或 process output。
- Verification 作为 Timeline 内的明确阶段，呈现检查状态和 Repair 轮次的公开摘要；不显示 raw evidence、diff 或 secrets。
- Active 使用 subtle spinner/pulse，settled 使用 check，failed/interrupted 使用 error/interrupted mark；不重复 requested/started/completed 三行状态。

Approval、Cancel、Reconnect、Recovery 均 inline：

- Approval 使用安全投影 `ApprovalView`，高风险只适度强调；`拒绝` 是次要/破坏性操作，`仅本次允许` 是主操作，`本次运行内允许` 是次主操作。处理后卡片消失或变成 settled activity，不保留可重复点击按钮。
- Active Run 只保留一个 `取消任务` 入口，Composer disabled。点击后显示 `正在取消任务……` 且按钮 disabled；只有 daemon 返回真实 `CANCELLED` 才显示最终状态。
- Reconnect 保留 Conversation/Timeline，仅在主区显示轻量 reconnect banner；exhausted 时提供一个手动 `重新连接`。
- Recovery 使用 inline panel/overlay；PENDING 需要 `继续启动` / `稍后处理`，多个 non-terminal Run 使用紧凑 icon + goal 选择，不创建新 Run。

## Composer and keyboard behavior

Composer 是底部唯一输入区，只支持文本任务；Enter 提交，Shift+Enter 换行，IME composing 状态下 Enter 不提交。Composer、Approval、Recovery、Reconnect 与 Cancel 都必须是 semantic buttons/inputs，键盘可达，并具有可见 focus。Escape 关闭适当 overlay/panel；新建会话、terminal settlement 和 approval/recovery 显示时保持可预测 focus。

## Long-running interaction

Timeline 拥有独立滚动容器与 bounded rendering。接近底部时新活动自动 follow；用户向上滚动后 detached，不抢回滚动位置；此时显示 bounded `N 条新活动` indicator，点击后回到底部并恢复 follow。新增活动不得让焦点漂移。大量活动必须使用稳定 key 与有限 DOM 窗口/截断策略，且不能把整个 Timeline 设为 `aria-live="assertive"`；只对 approval、连接断开、terminal 等重要状态使用适度 live region。

## Visual direction and tokens

视觉方向是克制的 dense analyst workspace：浅色、低噪声的中性表面，墨绿色品牌强调，细分隔线与紧凑的 mono secondary text。颜色只表达连接、运行、审批、失败、验证等语义，不使用大面积警告色或装饰性渐变。Typography 保持高可读性，控制/label/secondary text 具有明确层级；所有间距、颜色、边框、阴影、圆角和 motion 使用 CSS tokens。`prefers-reduced-motion: reduce` 时关闭 spinner/pulse/entrance animation。

## Data and security boundary

React 组件不接管 orchestration；`WebSessionManager` 继续负责 Session/Run/Approval/Recovery/transport 状态，`@caelush/client` 继续负责 browser-safe projection，daemon 仍是 Authority。Phase 13E 不修改 Protocol、Core、Security、Runtime、Verification、Storage、Tool、EventBus 或 daemon business API。UI 不读取或渲染 raw Tool args、credentials、environment、stdout/stderr、hidden reasoning、filesystem server、verification evidence 或 diff。

## Verification standard

Component tests 必须覆盖 icon-only Session Row、empty/selected/active states、Approval、Cancel、Reconnect、Recovery、Composer、keyboard/IME 与 long-running scroll behavior。Browser E2E 必须从真实 Production Web 经 `@caelush/client`、真实 daemon、真实 SQLite、真实 AgentLoop/Tool/Security/Verification 驱动 DOM；deterministic LLM HTTP fixture 允许，但不得 mock daemon、SSE、Session、Run、Approval、Timeline 或 Verification。Release 验证必须覆盖 Web assets、launcher、daemon static hosting、`build:release`、`test:release` 与 production smoke。

## Self-review

- Two-column only；没有 Right Inspector 或 Bottom Status Bar。
- Session Row 只有 status icon + title；accessible label 不改变可见布局。
- Conversation 与 Timeline 共用主工作区；不重复 Goal。
- Approval/Cancel/Reconnect/Recovery 都复用现有真实状态与 daemon authority。
- 该设计没有引入新的 backend product surface 或 unsupported feature UI。
