import type { AgentMessage } from "@caelush/agent";

import {
  parseTaskPlanInput,
  type TaskPlanExecution,
  type TaskPlanStep,
  type TaskPlanStepStatus,
} from "./task-plan-contract.js";
import {
  aggregateTaskPlanEvidenceState,
  type ResolvedTaskPlanEvidence,
  type TaskPlanEvidenceState,
} from "./task-plan-evidence.js";

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

export interface BoundedTaskPlanRender {
  readonly text: string;
  readonly includedSections: readonly string[];
  readonly omittedCounts: Readonly<Record<string, number>>;
}

export interface TaskPlanAvailableEvidenceRef {
  readonly reference: string;
  readonly description: string;
}

interface SemanticPlanSection {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly budget: number;
}

const SEMANTIC_PLAN_BUDGETS = Object.freeze({
  header: 512,
  meta: 768,
  current: 1792,
  unresolved: 1792,
  next: 768,
  constraints: 1024,
  remaining: 1536,
});

/**
 * Render the accepted plan under a byte budget while preserving the information the next action needs.
 *
 * The original snapshot stays in durable conversation history. This is only a bounded projection, so
 * it summarizes by section before clipping a field and always keeps a reference to the complete source.
 */
export function renderBoundedTaskPlan(
  snapshot: TaskPlanSnapshot,
  options: {
    readonly maxBytes?: number;
    readonly evidence?: readonly ResolvedTaskPlanEvidence[];
    readonly availableEvidenceRefs?: readonly TaskPlanAvailableEvidenceRef[];
  } = {},
): BoundedTaskPlanRender {
  const maxBytes = options.maxBytes ?? 8 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
    throw new RangeError("Task plan render budget must be at least 256 bytes.");
  }
  const ratio = Math.min(1, Math.max(0, (maxBytes - 8) / 8192));
  const budget = (key: keyof typeof SEMANTIC_PLAN_BUDGETS): number =>
    Math.floor(SEMANTIC_PLAN_BUDGETS[key] * ratio);
  const marks: Record<TaskPlanStepStatus, string> = {
    completed: "[x]",
    in_progress: "[>]",
    pending: "[ ]",
  };
  const evidenceByReference = new Map(
    (options.evidence ?? []).map((item) => [item.reference, item.state] as const),
  );
  const stepLine = (step: TaskPlanStep): string => {
    const identity = step.id === undefined ? "" : `${step.id} `;
    const acceptance =
      step.acceptance === undefined || step.acceptance.length === 0
        ? ""
        : ` — accept: ${step.acceptance.join("; ")}`;
    const evidence =
      step.evidenceRefs === undefined || step.evidenceRefs.length === 0
        ? ""
        : ` [claimed evidence: ${step.evidenceRefs.join(", ")} — unverified]`;
    const evidenceState = aggregateTaskPlanEvidenceState(step.evidenceRefs, evidenceByReference);
    const evidenceSummary =
      step.evidenceRefs === undefined || step.evidenceRefs.length === 0
        ? ""
        : ` — reportedStatus=${step.status}; independentEvidence=${evidenceState}`;
    return `${marks[step.status]} ${identity}${step.step}${acceptance}${evidence}${evidenceSummary}`;
  };
  const active = snapshot.steps.filter((step) => step.status === "in_progress");
  const pending = snapshot.steps.filter((step) => step.status === "pending");
  const current = active.length > 0 ? active : pending.slice(0, 1);
  const currentSet = new Set(current);
  const completed = snapshot.steps.filter((step) => step.status === "completed");
  const otherPending = pending.filter((step) => !currentSet.has(step));
  const execution = snapshot.execution;
  const sections: SemanticPlanSection[] = [
    {
      id: "meta",
      title: `目标与版本 (plan v${snapshot.planVersion}; ${snapshot.steps.length} steps)`,
      lines: [
        ...(execution?.goal === undefined
          ? []
          : [`Recorded goal (model's words): ${execution.goal}`]),
        ...(snapshot.explanation === undefined ? [] : [`Why it changed: ${snapshot.explanation}`]),
        `报告完成 ${completed.length}/${snapshot.steps.length}; accepted tool results since plan: ${snapshot.resultsSincePlan}. Activity is not verification.`,
      ],
      budget: budget("meta"),
    },
    {
      id: "current",
      title: `当前项 (${current.length}; ${active.length} in progress)`,
      lines: current.map(stepLine),
      budget: budget("current"),
    },
    {
      id: "unresolved",
      title: `UNRESOLVED — 未解决问题 (${execution?.unresolved?.length ?? 0}; must not be reported done)`,
      lines: execution?.unresolved ?? [],
      budget: budget("unresolved"),
    },
    {
      id: "next",
      title: "Next action",
      lines: execution?.nextAction === undefined ? [] : [execution.nextAction],
      budget: budget("next"),
    },
    {
      id: "constraints",
      title: `Constraints (${execution?.constraints?.length ?? 0})`,
      lines: execution?.constraints ?? [],
      budget: budget("constraints"),
    },
    {
      id: "remaining",
      title: `其余工作与记录 (${otherPending.length + completed.length + (execution?.discoveries?.length ?? 0) + (execution?.decisions?.length ?? 0)})`,
      lines: [
        ...otherPending.map(stepLine),
        ...completed.slice(-4).map(stepLine),
        ...(completed.length > 4
          ? [`${completed.length - 4} earlier completed steps omitted`]
          : []),
        ...(options.availableEvidenceRefs === undefined ||
        options.availableEvidenceRefs.length === 0
          ? []
          : [
              `可引用的真实证据引用（当前 Run 最近 ${Math.min(8, options.availableEvidenceRefs.length)} 条）:`,
              ...options.availableEvidenceRefs
                .slice(-8)
                .map(({ reference, description }) => `- ${reference} — ${description}`),
            ]),
        ...(execution?.discoveries ?? []).map((line) => `发现（报告）: ${line}`),
        ...(execution?.decisions ?? []).map((line) => `决定（报告）: ${line}`),
        `独立证据: ${taskPlanEvidenceState()} — no check has been shown to pass; claimed references remain unverified.`,
      ],
      budget: budget("remaining"),
    },
  ];

  const rendered = sections.map((section) => renderSemanticSection(section, section.budget));
  const header = `CURRENT PLAN v${snapshot.planVersion} — bounded accepted working projection; a completed mark is a report, not proof.\nFull snapshot reference: revision=${snapshot.revision}; sourceStep=${snapshot.sourceStepId ?? "unknown"}. The complete accepted plan remains in durable conversation history.`;
  const headerBudget = budget("header");
  const boundedHeader = truncateUtf8(header, Math.max(1, headerBudget), "header").text;
  const joinText = (): string =>
    [boundedHeader, ...rendered.map((entry) => entry.text).filter(Boolean)].join("\n");
  let text = joinText();
  // Unused capacity in sparse sections is borrowed by the highest-priority sections first. Each
  // section is re-rendered from the original source, so borrowing cannot stack lossy truncations.
  let remaining = Math.max(0, maxBytes - Buffer.byteLength(text, "utf8"));
  for (const id of ["meta", "current", "unresolved", "next", "constraints", "remaining"]) {
    if (remaining === 0) break;
    const index = sections.findIndex((section) => section.id === id);
    const current = rendered[index];
    const source = sections[index];
    if (current === undefined || source === undefined || current.omittedCount === 0) continue;
    const previousBytes = Buffer.byteLength(current.text, "utf8");
    const expanded = renderSemanticSection(source, source.budget + remaining);
    const gained = Math.max(0, Buffer.byteLength(expanded.text, "utf8") - previousBytes);
    if (gained === 0) continue;
    rendered[index] = expanded;
    remaining -= gained;
    text = joinText();
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = truncateUtf8(text, maxBytes, "plan").text;
  }
  const includedSections = rendered
    .filter((entry) => entry.text.length > 0)
    .map((entry) => entry.id);
  const omittedCounts = Object.fromEntries(
    rendered
      .filter((entry) => entry.omittedCount > 0)
      .map((entry) => [entry.id, entry.omittedCount]),
  );
  return Object.freeze({
    text,
    includedSections: Object.freeze(includedSections),
    omittedCounts: Object.freeze(omittedCounts),
  });
}

interface RenderedSemanticSection {
  readonly id: string;
  readonly text: string;
  readonly omittedCount: number;
}

function renderSemanticSection(
  section: SemanticPlanSection,
  maxSectionBytes: number,
): RenderedSemanticSection {
  const available = Math.max(0, maxSectionBytes - (Buffer.byteLength(section.title, "utf8") + 1));
  const body = section.lines.join("\n");
  const limited = truncateUtf8(body, available, section.id, section.lines.length);
  return {
    id: section.id,
    text: `${section.title}\n${limited.text}`,
    omittedCount: limited.omittedCount,
  };
}

function truncateUtf8(
  value: string,
  maxBytes: number,
  label: string,
  lineCount = 1,
): { readonly text: string; readonly omittedCount: number } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, omittedCount: 0 };
  const omittedCount = Math.max(1, lineCount);
  const marker = `… [${String(omittedCount)} item(s) summarized/truncated in ${label}]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    let output = "";
    for (const character of marker) {
      if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
      output += character;
    }
    return { text: output, omittedCount };
  }
  const contentBudget = maxBytes - markerBytes;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > contentBudget) break;
    output += character;
  }
  return { text: `${output}${marker}`, omittedCount };
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
