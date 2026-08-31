# Security Policy Kernel & Tool Execution Gate

本文档冻结 Caelush V1 Phase 9A/9B/9C/9D 的安全边界。Phase 9A 负责 metadata policy，Phase 9B 将 `REQUIRE_APPROVAL` 接入 durable Approval workflow，Phase 9C 增加 input-aware sensitive-resource/command overlay 与 secret-safe projections，Phase 9D 完成 logical/policy sandbox、Runtime child environment、structured helper 与 secure composition 集成。

## Responsibility boundary

`@caelush/security` 是纯 policy subsystem。它复用 `@caelush/protocol` 的 `PermissionProfile`、`ApprovalPolicy`、`Capability` 和 `RiskLevel`，消费 `@caelush/tools` 定义的 `ToolExecutionGatePort`，并为 Phase 11B 暴露一个结构化 verification command admission/sanitizer adapter；它不执行 Tool 或命令、不访问文件系统、不访问网络、不写 Storage、不发布 Event，也不依赖 Core、Runtime、LLM、Context、Verification 或宿主 App。

```text
durable AgentRun policy
        │
        ▼
ToolSecurityContext { permissionProfile, approvalPolicy }
        │
        ├── ToolDefinition metadata
        │     ├── requiredCapabilities
        │     └── riskLevel
        │
        └── containment classifier
                    │
                    ▼
          SecurityPolicyEvaluator
                    │
          ALLOW / DENY / REQUIRE_APPROVAL
                    │
                    ▼
             ToolExecutionGate
                    │
                    ▼
              ToolDispatcher
                    │
          ToolInvocation lifecycle
```

`ToolExecutionEnvironment` 和 `ToolSecurityContext` 是两个不同的 contract：前者描述“在哪个 workspace、使用哪个 runtime”，后者描述“这个 Run 允许做什么”。Permission policy 不得塞入 runtime environment，也不得由模型或 Tool arguments 提供。

## Capability matrix

| PermissionProfile | Granted capabilities                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `READ_ONLY`       | `FS_READ`, `GIT_READ`                                                                         |
| `PROJECT_ACCESS`  | `FS_READ`, `FS_WRITE`, `FS_DELETE`, `SHELL_EXEC`, `PROCESS_START`, `PROCESS_KILL`, `GIT_READ` |
| `FULL_ACCESS`     | 当前 Protocol Capability enum 的全部值                                                        |

`FULL_ACCESS` 只代表 capability grant，不会关闭 Phase 8 structured Tool 的 workspace、path、schema 或 runtime invariants。`PROJECT_ACCESS` 的 shell/process capabilities 也不意味着已有 OS-level hard sandbox。

## Containment classification

Containment 由 Tool 的 required capabilities 推导，不读取 Tool 名称，也不读取 invocation arguments：

| Required capability condition                        | Containment                |
| ---------------------------------------------------- | -------------------------- |
| 任意 `SHELL_EXEC`、`PROCESS_START` 或 `PROCESS_KILL` | `UNCONFINED_LOCAL_PROCESS` |
| 其他 capability 组合                                 | `STRUCTURED_WORKSPACE`     |

因此 `read_file`、`apply_patch` 和未来新增的 structured Tool 可以共享同一策略；策略内核不维护 Tool-name allowlist。

## Decision precedence

策略按以下顺序计算，结果是 deterministic、pure、没有 I/O 和 randomness：

1. Required capability 不在 active profile 中时，返回 `DENY / MISSING_REQUIRED_CAPABILITY`。Approval 不能授权缺失 capability。
2. `PROJECT_ACCESS + UNCONFINED_LOCAL_PROCESS + NEVER_ASK` 返回 `DENY / UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL`，因为 V1 尚无 hard sandbox。
3. `PROJECT_ACCESS + UNCONFINED_LOCAL_PROCESS` 在其他 approval policy 下返回 `REQUIRE_APPROVAL / UNCONFINED_EXECUTION_REQUIRES_REVIEW`。
4. `ALWAYS_ASK` 对 capability-authorized Tool 返回 `REQUIRE_APPROVAL`。
5. `DANGEROUS_ONLY` 对 `LOW`/`MEDIUM` 返回 `ALLOW`，对 `HIGH`/`CRITICAL` 返回 `REQUIRE_APPROVAL`。
6. `NEVER_ASK` 对 capability-authorized、非上述不安全 unconfined case 返回 `ALLOW`，绝不返回 `REQUIRE_APPROVAL`。

Decision 只包含稳定的 `kind`、`reasonCode` 和固定 safe reason。不得包含原始 arguments、shell command、stdin、文件内容、环境变量、凭据、绝对路径或 Provider 错误。

## Gate and lifecycle ownership

`CaelushToolExecutionGate` 只验证 Gate input、Tool identity、risk/capability metadata 和 `ToolSecurityContext`，然后调用 evaluator。它不修改 Invocation，也不创建 ApprovalRequest。Dispatcher 在 Gate 返回 `REQUIRE_APPROVAL` 后才使用注入的 approval port。

`ToolDispatcher` 仍然拥有唯一的 `ToolInvocation` lifecycle：

- `ALLOW`：Dispatcher durable-commit `RUNNING`，执行 handler，完成 observation/settlement。
- `DENY`：Dispatcher durable-commit sanitized `FAILED` / `PERMISSION_DENIED`，handler 调用次数为零。
- `REQUIRE_APPROVAL`：Dispatcher 计算 exact approval key；若没有同 Run、同 key 的已批准 RUN grant，则在同一 durable Tool transaction 中提交 `WAITING_APPROVAL`、PENDING ApprovalRequest 和 `approval.requested`，handler 调用次数为零，并停止当前 batch 的 trailing calls。

Phase 9B 的 `ApprovalRepository` 负责 `approval_requests`、15 分钟默认 TTL 的 lazy expiry、`approval.resolved` 以及严格的 APPROVE/REJECT transaction。RUN grant 只在同一 Run 和 exact key 下复用；ONCE grant 只绑定原始 ToolInvocation。RunController 的 `resolveApproval` 在锁内清除 approval pointer 后调用 Coordinator recovery，不重放 LLM turn。

## Run authority and recovery

RunController 从 durable `AgentRun.permissionProfile` 与 `AgentRun.approvalPolicy` 构造 `ToolSecurityContext`，同一 context 传入整个 ToolBatch，并由 Coordinator 传给每一次 Dispatcher dispatch/recovery。Run 状态或 snapshot policy 与 caller context 不一致时，RunController fail closed，不从历史 ToolObservation 猜测 policy。

Recovery 遵守既有 lifecycle 语义：terminal invocation 只重放已持久化结果，`WAITING_APPROVAL` 保持 waiting，`RUNNING` fail closed 为 uncertain，`REQUESTED` 可以用当前 durable Run context 重新经过 Gate。重新经过 Gate 不是对 terminal 或 waiting invocation 的静默重新授权，也不会自动重跑已有副作用。

## Explicit non-goals

Phase 9A 本身不实现：

- Approval persistence、resolution、approve/reject endpoint 或 approval cache；
- Phase 9C 之外的基于 command/file/input 内容的 policy；
- Phase 9C 之外的 secret detection、redaction、credential filtering 或 output scrubber；
- OS-level sandbox、container、seccomp、job object 或 process isolation；
- timeout、cancellation、retry、budget、parallel execution 或 Verification execution；
- Tool handler、Runtime、Storage、EventBus 或 AgentLoop 的第二份实现。

这些边界不是 capability evaluator 的隐含行为；Phase 9C 通过独立 facts、overlay、redactor 和 sanitizer contract 实现并测试。Phase 9D 已完成 logical/policy sandbox integration，但仍未实现 OS hard sandbox 或其他后续宿主能力。`STRUCTURED_WORKSPACE` 表示 workspace/path policy admission；`UNCONFINED_LOCAL_PROCESS` 明确表示本地 shell/process 没有 syscall、network 或 OS filesystem isolation。

## Phase 9C input-aware boundary

Dispatcher 在输入 schema 校验后生成 host-only Security Facts，Security Gate 先计算 Phase 9A base decision，再用 `DENY > REQUIRE_APPROVAL > ALLOW` 的纯 monotonic combiner 应用 sensitive-path/command/opaque/secret-bearing input overlay。当前 Gate 仍先于 Phase 9B exact RUN grant lookup。

Approval action 只使用已 redacted 的 fact-driven safe preview；ToolInvocation 的 raw `args` 仍是 private durable execution identity，不进入 lifecycle events、observations 或 model-facing projections。Tool result 必须 validate → sanitize → revalidate 后才可参与 effects、observation 和 storage。Phase 9C 不加 at-rest encryption，不能声称 secrets never exist in SQLite。

## Public API and dependency direction

Security 的公共入口从 `packages/security/src/index.ts` 导出：

`SecurityPolicyEvaluator`、`SecurityPolicyInput`、`SecurityDecision`、`SecurityDecisionCode`、`resolveGrantedCapabilities`、`ExecutionContainment` 和 `CaelushToolExecutionGate`。

依赖方向为：

```text
@caelush/tools  ── defines ──► ToolExecutionGatePort
       ▲
       │ consumes the port/type contract
@caelush/security ──► @caelush/protocol
```

`@caelush/tools` 不依赖 `@caelush/security`，避免工具 Kernel 和安全策略形成反向耦合。Architecture tests 会持续检查 Security source 中不存在 Runtime、Core、Storage、Events、LLM、Context、Verification、App 或 I/O imports。

Phase 11B 的 verification command adapter 复用同一 capability/command/input-policy 语义：候选命令与 Node 生命周期脚本 body 以 host-only structural input 进入评估；`DENY` 或 `REQUIRE_APPROVAL` 均 fail closed 为不执行的 verification `ERROR`，不创建新的 ApprovalRequest。其 evidence sanitizer 先做既有高置信度 redaction，再按 UTF-8 byte limit 截断；这不是 OS sandbox，也不是新的 permission system。

## Phase 12A daemon/client security boundary

Phase 12A keeps the security authority on the daemon and Core side. The shared
`@caelush/client` can select only a public `{ provider, model }` identity; it cannot
select an arbitrary provider `baseUrl`, send credentials, or override
Permission/Approval/Budget/Verification decisions. The daemon canonicalizes model
selection against startup-only server configuration, projects endpoint-bearing
internal models back to endpoint-free public entities, and maps unknown providers or
models to a bounded safe error.

Provider IDs and a public default model may appear in `/api/v1/info`; provider
endpoints, API keys, headers, raw SDK errors, prompts, Tool arguments, and secret
fragments do not. The daemon remains loopback-only and does not add permissive CORS
or network authentication in this round. `@caelush/client` validates API envelopes,
Protocol compatibility, and every `AgentEvent` SSE payload, but it is not a policy
engine and cannot authorize an action locally.
