/**
 * `@caelush/coding-agent` — Architecture V2 coding composition layer.
 *
 * Responsibility (Architecture V2, frozen):
 *   - General Agent to Coding Agent composition
 *   - Workspace Context Providers, Relevant File Providers, Project Instructions
 *   - Coding Tools, Coding Security, Coding Verification, Coding Prompt
 *   - Future Extension, Skill, and MCP surfaces
 *
 * This package may depend on `@caelush/agent`, `@caelush/ai`,
 * `@caelush/runtime`, and `@caelush/protocol`. It may never depend on
 * `@caelush/storage`, `@caelush/client`, or the Daemon, and no package may
 * depend back on it. Those boundaries are enforced by
 * `pnpm check:architecture`.
 *
 * Phase 1A creates the package identity and the build/dependency boundary only.
 * The Daemon composition, Coding Tools, Coding Verification, and Workspace
 * Context have not been moved here. The real coding business migrates in a later
 * phase.
 */
export {};
