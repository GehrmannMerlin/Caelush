# Agent Loop Architecture

Caelush Phase 6 is fixed to exactly three rounds:

1. **6A Contracts & State**
2. **6B Resumable Loop**
3. **6C Run Controller / Persistence / Events**

No additional Phase 6 rounds.

Phase 6A defines the language of the Agent Kernel without implementing the autonomous loop. The Kernel classifies one provider turn, exposes a tool boundary, tracks compact `AgentState` and `AgentStep` projections, and stops final answers at verification. Phase 6B will connect these contracts to context and the LLM Gateway. Phase 6C will add controller, persistence, and event trace integration.

## Execution boundary

```text
Observe
  ↓
Build Context
  ↓
LLM Provider Turn
  ↓
Agent Decision
  │
  ├──────── Tool Calls
  │             ↓
  │       External Tool Boundary
  │             ↓
  │         Tool Results
  │             ↓
  │        Resume Next Step
  │
  └──────── Final Candidate
                ↓
             VERIFYING
                ↓
         Future Verification
```

One settled LLM provider turn equals one Agent Step attempt. This includes a provider failure or a rejected model output after the step has started; a settled step is counted in `UsageState.steps`. A step helper receives its ID, sequence, and timestamps from its caller. The Kernel does not own a clock or an ID generator.

The decision union contains only:

- `TOOL_CALLS_REQUESTED`, with provider call identity preserved as `AgentToolRequest.externalCallId`.
- `FINAL_CANDIDATE`, with the exact original model text and no completion claim.

Tool calls are requested by the Agent Kernel but executed outside the Phase 6 Agent Kernel. The Kernel does not know concrete tools, does not own a registry or dispatcher, and does not create `ToolInvocationId` values. Tool results return through a complete resume batch. A batch must have exactly one result per requested call, match both call identity and tool name, and may contain an error result. Execution completion order is allowed to differ from assistant source order; normalization restores request order before model history is built.

## Finish reason matrix

| Finish reason    | With one or more tool calls                            | Without tool calls                                        |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `STOP`           | `TOOL_CALLS_REQUESTED`                                 | `FINAL_CANDIDATE` when text is nonblank; otherwise reject |
| `OTHER`          | `TOOL_CALLS_REQUESTED`                                 | `FINAL_CANDIDATE` when text is nonblank; otherwise reject |
| `TOOL_CALLS`     | `TOOL_CALLS_REQUESTED`                                 | Reject as missing tool calls                              |
| `LENGTH`         | Reject as truncated; never execute even if JSON parses | Reject as truncated                                       |
| `CONTENT_FILTER` | Reject filtered output                                 | Reject filtered output                                    |

Tool presence takes precedence over a normal stop reason. Text and tool calls are both preserved in the canonical assistant message, with the text part first and tool-call parts in the original provider order. Unknown schema-valid tool names are preserved for a later Tool System to validate; Phase 6A does not consult advertised definitions.

## Model output and public summaries

The mapper validates `LLMTurnResult` at the Kernel boundary, checks provider/model identity, rejects duplicate tool-call IDs, and validates the constructed `LLMAssistantMessage`. `LENGTH`, `CONTENT_FILTER`, blank finals, empty turns, and inconsistent tool-call output become sanitized `AgentModelOutputError` values. Error metadata is limited to non-sensitive identity/count fields.

`summarizeAgentDecision` is a public execution summary. A final candidate summary says that verification is required. A tool summary shows at most five tool names and a count. Summaries never include model answer text, hidden reasoning, tool arguments, provider responses, credentials, or secrets. They may later populate `AgentStep.reasoningSummary` or a public reasoning event, but they are not chain-of-thought.

## AgentState and AgentStep

`createInitialAgentState` projects a pending `AgentRun` into the existing compact `AgentState`: run/session identity, goal, workspace/runtime/policy fields, empty plan and observations, `NOT_RUN` verification, zero usage, and caller-supplied `updatedAt`. It does not copy model, limits, final result, or creation time. `startAgentState` uses the canonical Run State Machine for `PENDING → RUNNING`.

Beginning a step records `currentStepId` but does not increment steps. Settling it clears the active step and increments `UsageState.steps`, accumulating only known LLM input/output tokens. Missing token fields preserve existing totals; `totalTokens`, cached tokens, and reasoning tokens are not added to Protocol state. Model-requested tool calls do not increment `UsageState.toolCalls`, which is reserved for future actual Tool invocation accounting.

A final candidate can move an idle running state to `VERIFYING`, resetting verification to `NOT_RUN`. It never moves directly to `COMPLETED`. The only structural gate in Phase 6A is `maxSteps`; exhaustion is an expected `MAX_STEPS_REACHED` `AgentLoopOutcome`, not an LLM decision. Retry, backoff, timeout, token/cost/tool budgets, and verification execution remain later-phase responsibilities.

## Phase boundaries

Phase 6A has no AgentLoop, repeated LLM call, `ContextBuilder` or `LLMGateway` invocation, Tool execution, `ToolRegistry`, `ToolDispatcher`, approval resolution, Verification execution, Storage, EventBus, daemon integration, or host-specific runtime. The intended future loop is resumable: a tool decision yields at the external boundary, a complete normalized result batch resumes the next model step, and a final candidate proceeds to the verification boundary.
