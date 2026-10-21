import type { AgentMessageRecord } from "@caelush/agent";
import type { AgentRun, AgentStep } from "@caelush/protocol";

import type { RunContinuationCheckpoint } from "./agent-continuation.js";

/**
 * What a restart may do with a Step that was committed as `RUNNING` and never settled.
 *
 * ```text
 * REPLAY_SAFE   nothing durable came out of that attempt; sending the same turn again is safe
 * FAIL_CLOSED   the attempt may have changed the world; settle it as an error and never resend
 * ```
 *
 * ## The durable facts this decision is allowed to use
 *
 * ```text
 * no `llm.started` event             provider I/O never began
 * no assistant record for the Step   the provider turn produced no durable answer
 * no continuation                   nothing else durable is waiting on this Step
 * ```
 *
 * An assistant record with `sourceStepId === step.id` means the attempt *did* produce a decision —
 * including its tool calls — so the conversation and the Tool ledger already depend on it. A
 * continuation means the Run is parked on a specific boundary (tool results, approval, retry,
 * steering), and a fresh turn would bypass it.
 *
 * Neither fact is a heuristic: both are durable, and both are read from the same snapshot the
 * recovery path already loaded.
 *
 * ## What this deliberately does not decide
 *
 * The provider-start event is committed before provider I/O. Replaying is therefore allowed only
 * when the durable Store explicitly proves that event is absent; a missing/unknown projection fails
 * closed. The caller still bounds safe pre-provider reissues per Run to contain crash loops.
 */
export type InterruptedStepDisposition = "REPLAY_SAFE" | "FAIL_CLOSED";

export interface InterruptedStepFacts {
  readonly run: Pick<AgentRun, "status">;
  readonly activeStep?: Pick<AgentStep, "id"> | undefined;
  /** Missing evidence is unknown, never proof that provider I/O did not start. */
  readonly providerAttemptStarted?: boolean | undefined;
  readonly continuation?: RunContinuationCheckpoint | undefined;
  readonly conversationRecords: readonly Pick<AgentMessageRecord, "messageType" | "sourceStepId">[];
}

export function classifyInterruptedStep(facts: InterruptedStepFacts): InterruptedStepDisposition {
  const step = facts.activeStep;
  if (step === undefined) return "FAIL_CLOSED";
  // Only a RUNNING Run can re-enter the loop. A VERIFYING or waiting Run has its own boundary and
  // must keep the fail-closed settlement it already had.
  if (facts.run.status !== "RUNNING") return "FAIL_CLOSED";
  if (facts.continuation !== undefined) return "FAIL_CLOSED";
  if (facts.providerAttemptStarted !== false) return "FAIL_CLOSED";
  const producedOutput = facts.conversationRecords.some(
    (record) => record.sourceStepId === step.id,
  );
  return producedOutput ? "FAIL_CLOSED" : "REPLAY_SAFE";
}
