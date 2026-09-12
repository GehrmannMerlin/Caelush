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
 * This package must never know about a Coding Agent, concrete Runtime
 * operations, SQLite, the Daemon, a Client, Git, `read_file`, `exec_command`,
 * `apply_patch`, Node/Java project scanning, or the local filesystem. Those
 * boundaries are enforced by `pnpm check:architecture`.
 *
 * Phase 1A creates the package identity and the build/dependency boundary only.
 * No `@caelush/core`, `context`, `tools`, `security`, `memory`, or `events` code
 * has been moved here, and no guessed public API is declared. The real agent
 * kernel migrates in a later phase.
 */
export {};
