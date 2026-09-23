import type { RunExecutionSnapshot } from "@caelush/agent";
import type { RunExecutionSnapshotView } from "./run-execution-store.js";

/**
 * The projection from the Run Layer's compatibility view onto the canonical execution snapshot.
 *
 * Phase 3C moved the Run execution snapshot into `@caelush/agent`, so the Run Layer now *receives*
 * the canonical shape from its store rather than translating into it. What is left here is the one
 * thing the compatibility view adds: the coding-verification plan.
 *
 * The plan is dropped here and only here, which is what keeps a general Run from ever carrying a
 * coding artefact — the coordinator, the driver and the planner see the canonical snapshot, while
 * the verification path reads the plan from its own extension.
 */
export function toAgentExecutionSnapshot(snapshot: RunExecutionSnapshotView): RunExecutionSnapshot {
  // Written out member by member rather than spread-and-drop: `verificationPlan` is *excluded*
  // from the canonical snapshot, and naming every member that *is* included makes that exclusion a
  // reviewed decision instead of a side effect of a rest pattern.
  const canonical: RunExecutionSnapshot = {
    run: snapshot.run,
    ...(snapshot.state === undefined ? {} : { state: snapshot.state }),
    ...(snapshot.stateRevision === undefined ? {} : { stateRevision: snapshot.stateRevision }),
    ...(snapshot.activeStep === undefined ? {} : { activeStep: snapshot.activeStep }),
    conversationRecords: snapshot.conversationRecords,
    ...(snapshot.continuation === undefined ? {} : { continuation: snapshot.continuation }),
    ...(snapshot.continuationRevision === undefined
      ? {}
      : { continuationRevision: snapshot.continuationRevision }),
    ...(snapshot.cancellationIntent === undefined
      ? {}
      : { cancellationIntent: snapshot.cancellationIntent }),
  };
  return canonical;
}

/**
 * Project a durable Run status onto the frozen execution status.
 *
 * The two vocabularies are the same closed set, and the projection asserts that rather than
 * casting it: a status the coordinator cannot route must fail loudly at the boundary instead of
 * becoming `undefined` and being read as "this Run has no boundary".
 */
export function toExecutionStatus(
  status: import("@caelush/protocol").RunStatus,
): import("@caelush/agent").RunExecutionStatus {
  const statuses: readonly import("@caelush/agent").RunExecutionStatus[] = [
    "PENDING",
    "RUNNING",
    "WAITING_APPROVAL",
    "WAITING_RESOURCE",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ];
  const match = statuses.find((candidate) => candidate === status);
  if (match === undefined) {
    throw new Error(`Run status "${status}" is not a frozen execution status.`);
  }
  return match;
}
