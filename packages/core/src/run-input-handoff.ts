import type { AgentRun } from "@caelush/protocol";

import type { RunExecutionSnapshot } from "./run-execution-store.js";
import type { RunExecutionMessageAppend } from "./run-execution-store.js";
import type { RunMessageAuthority } from "./run-message-materializer.js";
import { createSteeringMessageAppend } from "./run-message-materializer.js";

/**
 * The Run Layer's input handoff boundary.
 *
 * ```text
 * frozen watermark    the inputs a boundary may apply, chosen once
 * FIFO prefix        oldest first, bounded by count and bytes
 * canonical USER     one message per input, in that order
 * ```
 *
 * Nothing here writes anything: the transaction that records these messages also writes the input
 * mappings, and the RunController owns that commit. The helpers are pure so the batch a boundary
 * applies can be asserted without a database.
 */

/** One input this boundary will materialize, with the message identity it was given. */
export interface MaterializedRunInput {
  readonly inputId: string;
  readonly acceptedSequence: number;
  readonly messageId: string;
}

export interface RunInputHandoffPlan {
  readonly appends: readonly RunExecutionMessageAppend[];
  readonly materialized: readonly MaterializedRunInput[];
  /** Recorded messages this boundary will carry into the next turn without re-materializing. */
  readonly carriedMessageIds: readonly string[];
  /** Every message the next turn must include, in conversation order. */
  readonly turnMessageIds: readonly string[];
}

/** Whether any accepted input has not yet been part of a prepared model step. */
export function hasUnassignedRunInputs(snapshot: RunExecutionSnapshot): boolean {
  return (snapshot.runInputs?.unassignedCount ?? 0) > 0;
}

/** The frozen FIFO prefix this snapshot offers, and nothing beyond it. */
export function frozenRunInputBatch(snapshot: RunExecutionSnapshot): readonly {
  readonly inputId: string;
  readonly acceptedSequence: number;
  readonly text: string;
}[] {
  return snapshot.runInputs?.pending ?? [];
}

/**
 * Materialize the frozen batch and carry any already-recorded inputs along.
 *
 * A recorded input is one whose USER record already exists but whose first model step was never
 * opened — a boundary that crashed after its handoff, or a Context selection that dropped it. It
 * is not materialized twice; it is carried into the same turn so the association can finally be
 * made, which is what keeps completion from being blocked forever by a message no request ever
 * claimed.
 */
export function planRunInputHandoff(
  authority: RunMessageAuthority,
  run: AgentRun,
  snapshot: RunExecutionSnapshot,
): RunInputHandoffPlan | undefined {
  const batch = frozenRunInputBatch(snapshot);
  const carried = snapshot.runInputs?.recorded ?? [];
  if (batch.length === 0 && carried.length === 0) return undefined;

  const appends: RunExecutionMessageAppend[] = [];
  const materialized: MaterializedRunInput[] = [];
  for (const entry of batch) {
    const created = createSteeringMessageAppend(authority, run, entry.text);
    appends.push(created.append);
    materialized.push({
      inputId: entry.inputId,
      acceptedSequence: entry.acceptedSequence,
      messageId: created.messageId,
    });
  }
  return {
    appends,
    materialized,
    carriedMessageIds: carried.map((entry) => entry.messageId),
    turnMessageIds: [
      ...carried.map((entry) => entry.messageId),
      ...materialized.map((entry) => entry.messageId),
    ],
  };
}

/** The ledger entries a handoff commit records, in acceptance order. */
export function handoffEntries(
  plan: RunInputHandoffPlan,
): readonly { inputId: string; acceptedSequence: number; messageId: string }[] {
  return plan.materialized;
}
