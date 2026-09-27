# Phase 8A Context Compaction: Pressure and Protocol-Safe Cut

Phase 8A adds the Agent-owned foundation for Context Compaction V2. It does not
start the semantic summary, checkpoint-chain, authority enrichment, persistence,
or provider-overflow orchestration phases.

## Phase 8A scope

The Context Engine now evaluates compaction pressure immediately before the
existing compaction path. The evaluator receives the already-resolved policy
budget and thresholds; it does not calculate model limits, call a provider, or
perform persistence. Its trigger precedence is:

1. `FORCED_PROVIDER_OVERFLOW` for an explicit `FORCED_RECOVERY` preparation;
2. `SELECTION_PRESSURE` when mandatory input exceeds the effective input limit;
3. `EMERGENCY_PRESSURE` or `PROACTIVE_PRESSURE` from the policy thresholds;
4. `NONE` otherwise.

Compaction is suppressed when the selected trigger has no legal compressible
history. The pressure ratio uses the effective input budget, and the hysteresis
target is derived from the proactive threshold. `targetRecentTailTokens` is a
retention target, not an independent compaction trigger.

## Pressure ownership

`ContextPolicy` remains the sole model-window and effective-input-budget
authority. `ContextPressureEvaluator` is a pure Agent Context function over
resolved numeric values. The Engine includes request overhead in the pressure
input and maps `EMERGENCY_PRESSURE` to the existing durable
`PROACTIVE_PRESSURE` compaction reason; no new durable reason was introduced.

The AgentLoop remains the only owner of provider-overflow recovery. It still
allows at most one `FORCED_RECOVERY` preparation and one additional provider
attempt; a repeated overflow becomes context exhaustion without a third call.

## Cut semantics

`ContextHistoryIndex` remains the semantic history authority. Durable message
sequence is the total-order identity. Primary `CONVERSATION_TURN` units are
canonical for normal selection; overlapping `TOOL_PROTOCOL` views are not
double-counted. Indexed message references carry an optional provider-neutral
UTF-8 token estimate so protocol-safe partial-turn candidates can calculate a
stable retained total without introducing a tokenizer dependency.

The selector scans deterministic unit order, protects the newest/current Turn,
and chooses the legal candidate whose retained tail is closest to the target
while satisfying the minimum tail. A `TURN_BOUNDARY` cut is preferred whenever
one is legal. The resulting compaction plan carries the selected cut, selected
and retained unit identities, selected/retained token estimates, and both tail
targets.

For a multi-Turn range, the `conversationTurnId` is the first selected durable
message's anchor Turn. The Engine's summary source lookup matches the selected
run and inclusive durable sequence interval; it does not require every message
in the interval to share the anchor Turn ID.

## OPEN protocol rule

An `OPEN` `ToolProtocolUnit` is pinned, non-eligible, non-droppable, and
non-splittable. The selector never crosses an open protocol or treats it as a
safe cut boundary. A complete closed protocol remains atomic, including an
Assistant message that announces multiple Tool calls.

## Full-Turn preference and protocol-safe split

Full `ConversationTurn` boundaries are enumerated first. A huge historical Turn
may use `PROTOCOL_SAFE_SPLIT` only when it contains multiple complete
`CLOSED`/eligible Tool Protocol units and all earlier history crossed by the
candidate is also safely compactable. The boundary is between complete protocol
units, never inside a ToolCall/ToolResult pair, an open protocol, or a multi-tool
Assistant message. The original User message remains on the compacted semantic
source side of the split.

## Compatibility and out of scope

The existing Context Engine ports, summarization runner, checkpoint repository,
commit port, rehydrator, materializer, and durable event/notifier interfaces
remain unchanged. Existing V1 checkpoint decode and V2 coverage behavior remain
outside this phase's changes.

The following are deliberately not started in Phase 8A: semantic summary model
work, summary validation, incremental checkpoint resolution, deterministic
authority enrichment, immutable checkpoint persistence changes, a
`ContextCompactionCoordinator`, budget/cost accounting, true `tokensAfter`
rebuild, Session Tree/LCA behavior, or a second provider recovery path.

## Validation evidence

The focused Phase 8A validation covers pressure thresholds and hysteresis,
history indexing, full-turn selection, OPEN/closed Tool Protocol behavior,
huge-Turn protocol-safe splitting, deterministic sequence ordering,
multi-Turn range anchoring, Engine compatibility, and the existing exactly-one
overflow recovery regressions. Architecture tests enforce Agent ownership,
public-entry-point exports, the absence of Storage/daemon/provider/artifact
dependencies in the new kernel, and AgentLoop-only forced recovery.
