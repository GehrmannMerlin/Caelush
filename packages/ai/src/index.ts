/**
 * `@caelush/ai` — Architecture V2 model and provider layer.
 *
 * Responsibility (Architecture V2, frozen):
 *   - Model and Model Capability
 *   - Provider and API Adapter
 *   - AI Message, AI Tool Spec, Stream, Usage
 *   - Reasoning metadata, Cache metadata, Authentication
 *
 * This package knows nothing about Run, Session, Workspace, Runtime, Storage,
 * Daemon, Approval, Verification, Coding, Git, or the local filesystem. Those
 * boundaries are enforced by `pnpm check:architecture`.
 *
 * Phase 1A creates the package identity and the build/dependency boundary only.
 * No `@caelush/llm` code has been moved here and no compatibility re-export
 * exists. The real model runtime migrates in a later phase.
 */
export {};
