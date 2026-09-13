import type { AIModelRequest, ModelDescriptor } from "@caelush/ai";

import type { AgentExecutionIdentity, AgentTurnRef } from "../types.js";

/**
 * The durable model turn boundary.
 *
 * The invariant this port exists to enforce is the highest-priority recovery invariant
 * of the phase:
 *
 * ```text
 * Durable Step commit MUST succeed
 *        ↓
 * only then may Provider I/O begin
 * ```
 *
 * If the durable commit fails, `beforeExecute` rejects and **no provider call happens**.
 * That is what makes a crash recoverable: a Run that restarted either finds a committed
 * Step that really was attempted, or finds no Step at all and can safely decide what to
 * do next. The failure mode this prevents is the opposite one — a provider call whose
 * Step never became durable, which no recovery can reason about.
 *
 * The port is generic on purpose. It does not name a Step, a continuation, a store or an
 * event: a durable implementation binds it to the Run Execution store, and its owner is
 * the Run Layer. The agent kernel only knows that it must be called first.
 */
export interface ModelTurnBoundaryPort {
  /**
   * Commit everything that must be durable before the provider is contacted.
   *
   * It must be idempotent for the same `turn`, must not perform provider I/O, and must
   * reject rather than resolve when the durable commit did not succeed.
   */
  beforeExecute(input: ModelTurnBoundaryInput): Promise<void>;
}

/** What the durable boundary is asked to commit before one model turn. */
export interface ModelTurnBoundaryInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly request: AIModelRequest;
  /** The resolved model authority the turn will execute against. */
  readonly model: ModelDescriptor;
}
