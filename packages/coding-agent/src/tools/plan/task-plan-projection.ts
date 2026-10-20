import type { AgentMessage } from "@caelush/agent";

import {
  parseTaskPlanInput,
  type TaskPlanExecution,
  type TaskPlanStep,
  type TaskPlanStepStatus,
} from "./task-plan-contract.js";

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
  /** Which plan shape the accepted payload declared. */
  readonly planVersion: 1 | 2;
  readonly steps: readonly TaskPlanStep[];
  /** Why the list or the understanding changed, when the model said so. */
  readonly explanation?: string;
  /** The bounded working record, when the model recorded one. */
  readonly execution?: TaskPlanExecution;
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
 * What independent evidence says about a plan, as opposed to what the model reported.
 *
 * ```text
 * UNVERIFIED   the plan is a report; nothing has checked it, and this projection cannot check it
 * ```
 *
 * The distinction is the whole point of the field. A model that marks every step completed has
 * reported an opinion; a reader that rendered that as a state would be laundering an opinion into a
 * fact. When a Run does have verification records, their state is rendered beside the report rather
 * than replacing it — this projection never turns "no check ran" into "passed", and never turns a
 * missing reference into a failure.
 */
export type TaskPlanEvidenceState = "UNVERIFIED";

/**
 * Derive the latest accepted plan from the messages of one Run.
 *
 * `RUN_SCOPED` on purpose: a plan belongs to the Run that recorded it. A later Run in the same
 * Session starts without one, which is what lets a resumed task state its own steps instead of
 * inheriting a list it never saw.
 *
 * Only an *accepted* result advances the plan. A rejected `update_plan` — a malformed payload, a
 * version mismatch — produces an error Tool result, and an error never becomes the current plan: the
 * model is told what was wrong and the previous snapshot stays authoritative until it is replaced.
 */
export function deriveTaskPlanSnapshot(input: {
  readonly runId: string;
  readonly messages: readonly {
    readonly message: AgentMessage;
    readonly sequence: number;
  }[];
}): TaskPlanSnapshot | undefined {
  const requested = new Map<string, { readonly input: unknown }>();
  for (const entry of input.messages) {
    const message = entry.message;
    if (message.type !== "ASSISTANT" || message.runId !== input.runId) continue;
    for (const part of message.content) {
      if (part.type !== "TOOL_CALL" || part.toolName !== "update_plan") continue;
      requested.set(part.toolCallId, { input: part.input });
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
    const parsed = parseTaskPlanInput(call.input);
    if (!parsed.ok) continue;
    const plan = parsed.plan;
    latest = Object.freeze({
      revision: message.id,
      ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
      planVersion: plan.planVersion,
      steps: plan.steps,
      ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
      ...(plan.execution === undefined ? {} : { execution: plan.execution }),
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

/** The plan's independent-evidence state. This projection can only ever report that none exists. */
export function taskPlanEvidenceState(): TaskPlanEvidenceState {
  return "UNVERIFIED";
}

/**
 * Render a snapshot as the bounded block a Context contribution carries.
 *
 * The block is ordered by what a long task needs after a context rebuild: what the goal and current
 * step are, what changed and why, what is still unresolved, and what happens next. Completed steps come
 * last and are folded when there are many, because a list of finished work is the least useful part of
 * a plan to spend context on.
 */
export function renderTaskPlanBlock(snapshot: TaskPlanSnapshot): string {
  const marks: Record<TaskPlanStepStatus, string> = {
    completed: "[x]",
    in_progress: "[>]",
    pending: "[ ]",
  };
  const completed = snapshot.steps.filter((step) => step.status === "completed");
  const active = snapshot.steps.filter((step) => step.status === "in_progress");
  const pending = snapshot.steps.filter((step) => step.status === "pending");
  const line = (step: TaskPlanStep): string => {
    const id = step.id === undefined ? "" : `${step.id} `;
    const acceptance =
      step.acceptance === undefined || step.acceptance.length === 0
        ? ""
        : ` — accept: ${step.acceptance.join("; ")}`;
    const evidence =
      step.evidenceRefs === undefined || step.evidenceRefs.length === 0
        ? ""
        : ` [claimed evidence: ${step.evidenceRefs.join(", ")} — unverified]`;
    return `${marks[step.status]} ${id}${step.step}${acceptance}${evidence}`;
  };
  const MAX_COMPLETED_LINES = 4;
  const completedLines =
    completed.length <= MAX_COMPLETED_LINES
      ? completed.map(line)
      : [
          ...completed.slice(-MAX_COMPLETED_LINES).map(line),
          `(+${String(completed.length - MAX_COMPLETED_LINES)} earlier completed step(s) omitted)`,
        ];
  const execution = snapshot.execution;
  return [
    `CURRENT PLAN v${String(snapshot.planVersion)} (recorded by the model; a step marked completed is a report, not proof)`,
    ...(snapshot.explanation === undefined ? [] : [`Why it changed: ${snapshot.explanation}`]),
    ...(execution?.goal === undefined ? [] : [`Recorded goal (model's words): ${execution.goal}`]),
    ...(execution?.constraints === undefined
      ? []
      : [`Constraints: ${execution.constraints.join("; ")}`]),
    ...active.map(line),
    ...pending.map(line),
    ...completedLines,
    `${String(completed.length)} of ${String(snapshot.steps.length)} steps reported completed.`,
    ...(execution?.discoveries === undefined
      ? []
      : [`Findings (reported): ${execution.discoveries.join("; ")}`]),
    ...(execution?.decisions === undefined
      ? []
      : [`Decisions (reported): ${execution.decisions.join("; ")}`]),
    ...(execution?.unresolved === undefined || execution.unresolved.length === 0
      ? []
      : [`UNRESOLVED (must not be reported as done): ${execution.unresolved.join("; ")}`]),
    ...(execution?.nextAction === undefined ? [] : [`Next action: ${execution.nextAction}`]),
    `Evidence: ${String(snapshot.resultsSincePlan)} successful Tool result(s) accepted since this plan was recorded; accepted activity is not verification.`,
    `Independent evidence: ${taskPlanEvidenceState()} — no check has been shown to pass for this plan. Claimed evidence references are the model's, not verified facts.`,
  ].join("\n");
}

/**
 * Truncate a rendered block to a UTF-8 byte budget without splitting a character.
 *
 * A character slice is not a byte bound: 4 KiB of Chinese is a different number of characters than
 * 4 KiB of ASCII, and slicing by characters could leave a broken sequence. This walks code points and
 * stops before the budget, so the result is always valid UTF-8 and always within the limit.
 */
export function boundPlanBlock(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n[plan truncated to fit the context budget]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) break;
    used += size;
    end += character.length;
  }
  return `${text.slice(0, end)}${marker}`;
}
