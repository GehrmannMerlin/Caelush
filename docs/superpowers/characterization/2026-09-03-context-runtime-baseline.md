# Context Runtime Baseline Characterization

## Scope

This characterization records the pre-refactor behavior at BASE_SHA
`1976ec06f4c06de56d28f92954e8dd789ba0b109`. It intentionally does not change the production context semantics.

## Current path

The current long-run path is:

`AgentLoop.run()` / `AgentLoop.resumeWithToolResults()` in `packages/core/src/agent-loop.ts`
→ `prepareResumeHistory()` in `packages/core/src/agent-loop-history.ts`
→ `historyBeforeCurrentTurn` plus `currentTurnMessages`
→ `ContextBuilder.build()` in `packages/context/src/context-builder.ts`
→ `assembleContextBudget()` in `packages/context/src/context-budget.ts`
→ `ContextBudgetExceededError` in `packages/context/src/errors.ts`
→ `mapAgentLoopError()` in `packages/core/src/agent-error-mapper.ts`
→ runtime budget error presentation/termination.

`prepareResumeHistory()` finds the last user message and treats everything from that message through the pending assistant and newly normalized tool results as one open current turn. When a Run has only its original User Goal, every later Assistant/Tool cycle remains inside that same slice.

## Evidence

`packages/core/test/context-runtime-characterization.test.ts` runs 32 continuation cycles from one User Goal. The observed trace starts at 3 messages and ends at 65 messages. The estimated JSON message-token total also increases monotonically. This proves that the old current-turn representation is proportional to the whole open Run rather than to a bounded working set.

With a 16,000-token input limit and 512-token safety margin, the same healthy continuation with large but valid build observations fails in `ContextBuilder.build()` because `assembleContextBudget()` adds all `currentTurnMessages` to `mandatoryTokens`. The resulting `ContextBudgetExceededError` is a context-runtime failure; it is not evidence that the Agent exceeded its lifetime resource policy.

A one-megabyte build-log-shaped Tool result remains as the `content` field of the durable `role: "tool"` message and therefore enters the model history unpruned. There is no separate Model Observation or Artifact projection in the baseline.

## Root cause

The baseline conflates durable execution history with mandatory model context. A single User Goal creates an effectively infinite current turn, and `ContextBuilder` correctly refuses to drop mandatory content. The 32K default is only the final admission ceiling; the actual pressure is created by the current-turn classification and raw Tool result inclusion.

## Current limits

The current builder validates `maxInputTokens` and uses defaults of 512 safety tokens, 12,000 conversation tokens, 12,000 relevant-file tokens, and 128 minimum relevant-file tokens. Optional conversation/files are budgeted after system plus current-turn content, but current-turn content is mandatory. There is no model-specific context profile, pressure zone, observation cap, execution-unit safe cut, checkpoint, rehydration, or provider overflow recovery.

## Safe-cut implication

The existing conversation validator already rejects orphan Tool results, missing Tool results, duplicate calls, and mismatched tool names. Any future projection/compaction must preserve the same Assistant tool-call plus all matching Tool results as one atomic unit; it may not remove one side of the pair.
