/**
 * `@caelush/agent` — Architecture V2 general agent kernel.
 *
 * Responsibility (Architecture V2, frozen):
 *   - General Agent, Agent Loop, Run Lifecycle contracts
 *   - Context Engine, Message Domain, Tool Framework
 *   - Generic Security, Generic Completion Gate, Memory contracts
 *   - Session Conversation Domain, Agent Events
 *   - Recovery, Retry, Budget, Resource Governance
 *
 * This package must never know about a Coding Agent, concrete Runtime operations,
 * SQLite, the Daemon, a Client, Git, `read_file`, `exec_command`, `apply_patch`,
 * Node/Java project scanning, or the local filesystem. Those boundaries are
 * enforced by `pnpm check:architecture`.
 *
 * Phase 2C activates the first real implementation: the model turn executor. The
 * rest of the agent kernel migrates in later phases, and no guessed public API is
 * declared ahead of its implementation.
 */
export { createModelTurnExecutor } from "./model-turn-executor.js";
export type {
  ModelTurnExecutionInput,
  ModelTurnExecutor,
  ModelTurnExecutorDependencies,
  ModelTurnStreamSink,
} from "./model-turn-executor.js";
