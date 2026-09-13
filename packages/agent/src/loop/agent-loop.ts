import type { AgentLoopAdvanceInput, AgentLoopAdvanceResult } from "./types.js";

/**
 * The frozen AgentLoop contract.
 *
 * ```text
 * AgentLoop = one Reason Kernel
 * ```
 *
 * One `advance()` is exactly one Reason: one context preparation, one request, one
 * admission decision, one durable boundary commit, one model turn, one classification.
 * There is no `while`, so the loop cannot execute a Tool and cannot run a Run.
 *
 * What the loop owns, and nothing else:
 *
 * ```text
 * the order of one turn's steps
 * ```
 *
 * What it must never own — each has its own authority, and each is a port the host
 * injects if the loop needs to observe it at all:
 *
 * ```text
 * Tool execution          the Tool Layer
 * Run status              the Run Layer
 * Step identity           the Run Layer (it arrives in AgentTurnRef)
 * time and identifiers    the Run Layer
 * verification            the Completion Gate
 * retry, timeout, budget  the Run Layer's policy
 * context construction    the Context Engine
 * ```
 *
 * The dependency shape is frozen to the smallest set that can perform one Reason:
 *
 * ```text
 * contextEngine
 * modelTurnExecutor
 * decisionClassifier
 * modelAdmission?
 * modelTurnBoundary?
 * ```
 *
 * and deliberately excludes a project inspector, a relevant-file planner, a context
 * builder, a clock, a step-id factory and lifecycle hooks: the general kernel has no
 * coding-agent knowledge and no self-managed lifecycle.
 *
 * Phase 3A freezes this contract only. `advance()` is implemented in Phase 3B, so no
 * guessed behaviour is declared here ahead of its implementation.
 */
export interface AgentLoop {
  advance(input: AgentLoopAdvanceInput): Promise<AgentLoopAdvanceResult>;
}
