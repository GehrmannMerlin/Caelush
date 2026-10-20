import type { AgentMessage } from "@caelush/agent";

import { validatePlanSteps, type PlanStep } from "../builtins/update-plan.js";

/**
 * The plan a Run is currently working through, derived from accepted facts.
 *
 * ```text
 * assistant TOOL_CALL update_plan   what the model asked to record
 * TOOL_RESULT for the same callId   whether the Run accepted it
 * ```
 *
 * Both halves are needed and neither is a hint: an assistant message alone may belong to a batch the
 * Run never accepted, and a Tool result alone does not say what was asked. The pair is the same
 * evidence every other durable fact uses, which is why this needs no plan table, no revision counter
 * and no writer.
 *
 * The revision is the accepting message's id: a stable identity for one exact snapshot, so a reader
 * can tell "same plan" from "a plan that happens to look the same".
 */
export interface TaskPlanSnapshot {
  readonly revision: string;
  readonly sourceStepId?: string;
  readonly steps: readonly PlanStep[];
  /**
   * Successful Tool results accepted after this plan was recorded.
   *
   * It is a count, not a judgement: it says "work happened after the plan", which is the only thing
   * the message log proves. It never claims a step is done - a completed step is the model's report,
   * and a verification is a different fact that only the verification records can supply.
   */
  readonly resultsSincePlan: number;
}

/**
 * Derive the latest accepted plan from the messages of one Run.
 *
 * `RUN_SCOPED` on purpose: a plan belongs to the Run that recorded it. A later Run in the same
 * Session starts without one, which is what lets a resumed task state its own steps instead of
 * inheriting a list it never saw.
 */
export function deriveTaskPlanSnapshot(input: {
  readonly runId: string;
  readonly messages: readonly {
    readonly message: AgentMessage;
    readonly sequence: number;
  }[];
}): TaskPlanSnapshot | undefined {
  const requested = new Map<string, { readonly input: unknown; readonly sequence: number }>();
  for (const entry of input.messages) {
    const message = entry.message;
    if (message.type !== "ASSISTANT" || message.runId !== input.runId) continue;
    for (const part of message.content) {
      if (part.type !== "TOOL_CALL" || part.toolName !== "update_plan") continue;
      requested.set(part.toolCallId, { input: part.input["plan"], sequence: entry.sequence });
    }
  }
  if (requested.size === 0) return undefined;

  let latest: TaskPlanSnapshot | undefined;
  for (const entry of input.messages) {
    const message = entry.message;
    if (message.type !== "TOOL_RESULT" || message.runId !== input.runId) continue;
    if (message.toolName !== "update_plan" || message.isError) continue;
    const call = requested.get(message.toolCallId);
    if (call === undefined) continue;
    const validated = validatePlanSteps(call.input);
    if (!validated.ok) continue;
    latest = Object.freeze({
      revision: message.id,
      ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
      steps: validated.steps,
      resultsSincePlan: input.messages.filter(
        (candidate) =>
          candidate.sequence > entry.sequence &&
          candidate.message.type === "TOOL_RESULT" &&
          candidate.message.runId === input.runId &&
          candidate.message.toolName !== "update_plan" &&
          !candidate.message.isError,
      ).length,
    });
  }
  return latest;
}

/** Render a snapshot as the bounded block a Context contribution carries. */
export function renderTaskPlanBlock(snapshot: TaskPlanSnapshot): string {
  const marks = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;
  const lines = snapshot.steps.map(
    (step, index) => `${String(index + 1)}. ${marks[step.status]} ${step.step}`,
  );
  const completed = snapshot.steps.filter((step) => step.status === "completed").length;
  return [
    "CURRENT PLAN (recorded by the model; a step marked completed is a report, not proof)",
    ...lines,
    `${String(completed)} of ${String(snapshot.steps.length)} steps reported completed.`,
    `Evidence: ${String(snapshot.resultsSincePlan)} successful Tool result(s) accepted since this plan was recorded.`,
    "A completed step is not a verification; only a check that actually ran proves anything.",
  ].join("\n");
}
