/**
 * The legacy durable Tool execution store contract.
 *
 * ```text
 * Phase 4C moved the canonical contract to @caelush/agent
 * this module re-exports it
 * ```
 *
 * `ToolExecutionStorePort`, its snapshot, its commit and its commit result are the durable boundary of
 * the Tool lifecycle, and the coordinator that owns that lifecycle now declares them. Storage
 * implements the canonical contract directly.
 *
 * The two durable error classes are **the same classes**, re-exported. Callers catch them by identity,
 * so a second class with the same name would make `error instanceof ToolExecutionConflictError`
 * silently false for one of the two — and a lost conflict is a blind retry on a row another writer
 * already moved.
 */
export { ToolExecutionConflictError, ToolExecutionInvariantError } from "@caelush/agent";
export type {
  DurableToolEvent,
  DurableToolEventDraft,
  ToolExecutionCommit,
  ToolExecutionCommitResult,
  ToolExecutionSnapshot,
  ToolExecutionStorePort,
} from "@caelush/agent";
