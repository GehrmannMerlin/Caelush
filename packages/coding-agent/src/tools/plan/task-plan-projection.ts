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
  /**
   * The most recent `update_plan` call that was refused *after* this revision was accepted.
   *
   * A refusal is not a plan: nothing was recorded and this snapshot is still the current one. It is
   * carried anyway because a model that cannot see the refusal in its Context re-sends the same
   * rejected shape, and a model that has forgotten the plan is stale keeps working against a list it
   * outgrew. Both are reminders, not gates.
   */
  readonly rejectedUpdate?: { readonly reason: string };
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
  let acceptedAt = 0;
  for (const entry of input.messages) {
    const message = entry.message;
    if (message.type !== "TOOL_RESULT" || message.runId !== input.runId) continue;
    if (message.toolName !== "update_plan" || message.isError) continue;
    const call = requested.get(message.toolCallId);
    if (call === undefined) continue;
    const parsed = parseTaskPlanInput(call.input);
    if (!parsed.ok) continue;
    const plan = parsed.plan;
    acceptedAt = entry.sequence;
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
  if (latest === undefined) return undefined;

  /*
   * A refusal that came *after* the accepted plan is an open question about the record.
   *
   * ```text
   * before the accepted plan   the model already corrected it; the accepted revision is the answer
   * after it                   the model tried to update the plan and the update was thrown away
   * ```
   *
   * The reason is read from the durable result it was refused with, so the fact survives a restart and
   * a compaction that keeps the Tool result. The pattern is the one this repository writes — a code,
   * not a free sentence — and an unrecognised text yields `REJECTED` rather than an echoed payload.
   */
  const refusal = lastRefusedUpdate(input.messages, input.runId, acceptedAt);
  if (refusal === undefined) return latest;
  return Object.freeze({ ...latest, rejectedUpdate: refusal });
}

const REFUSAL_CODE = /^Tool operation failed: ([A-Z][A-Z0-9_]{2,60})\./u;

/**
 * The most recent refused `update_plan` result after the accepted revision, if any.
 *
 * Only the code is kept: the rest of the refusal is guidance the model has already read, and a
 * projection that repeated it would make every Step's plan Section depend on prose.
 */
function lastRefusedUpdate(
  messages: readonly {
    readonly message: AgentMessage;
    readonly sequence: number;
  }[],
  runId: string,
  afterSequence: number,
): { readonly reason: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const message = entry?.message;
    if (message === undefined) continue;
    if (message.type !== "TOOL_RESULT" || message.runId !== runId) continue;
    if (message.toolName !== "update_plan" || !message.isError) continue;
    if (entry === undefined || entry.sequence <= afterSequence) return undefined;
    const text =
      typeof message.projectedContent === "string" ? message.projectedContent.trim() : "";
    const code = REFUSAL_CODE.exec(text)?.[1];
    return { reason: code ?? "REJECTED" };
  }
  return undefined;
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

/**
 * The same render, kept in the three blocks a Prompt Surface needs.
 *
 * ```text
 * current  6 KiB   goal, current step, unresolved, next action, constraints, remaining work
 * evidence 1.5 KiB what an independent check can say about the references the plan cited
 * notice   0.5 KiB the volatile bookkeeping: completion count, accepted results, this revision
 * ```
 *
 * A Prompt Surface Section changes as a whole, so the split is a cost decision, not a formatting
 * one: a single 8 KiB block whose last line counts Tool results rewrites 8 KiB on every Step, while
 * three blocks rewrite the 0.5 KiB notice. The volatile count lives in `notice` for exactly that
 * reason and never in the stable body.
 */
export interface BoundedTaskPlanSectionsRender {
  readonly current: string;
  readonly evidence: string;
  readonly notice: string;
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

/**
 * The block shares, which sum to the 8 KiB the plan may occupy at the default budget.
 *
 * `current` carries the whole working record, so it gets the room; `evidence` is bounded because it
 * is a summary of checks, not the checks; `notice` is small because it is bookkeeping the model reads
 * to judge staleness, never work.
 *
 * A smaller total budget scales these shares, and the notice additionally keeps a floor of its two
 * mandatory lines — the stable body is what gives up the difference, never the record's identity.
 * The shares are therefore inputs to the planner, not guarantees about each block's final size.
 */
export const TASK_PLAN_BLOCK_BUDGETS = Object.freeze({
  current: 6 * 1024,
  evidence: 1_536,
  notice: 512,
});

const SEMANTIC_PLAN_BUDGETS = Object.freeze({
  meta: 512,
  current: 1_792,
  unresolved: 1_536,
  next: 512,
  constraints: 768,
  remaining: 1_024,
});

/**
 * Section order, which is also the order that borrows unused capacity.
 *
 * ```text
 * meta current unresolved next constraints remaining
 * ```
 *
 * Evidence is its own block above the discretionary tail on purpose. A step's recorded references are
 * what lets the next turn cite a check that exists instead of inventing one, so they must not be the
 * first thing a long plan clips away. The sum of these section budgets is exactly the `current` block
 * budget, so borrowing can never push the block past its cap.
 */
const SEMANTIC_PLAN_SECTION_ORDER = [
  "meta",
  "current",
  "unresolved",
  "next",
  "constraints",
  "remaining",
] as const;

const MAX_EVIDENCE_ENTRIES = 4;
const EVIDENCE_DESCRIPTION_BYTES = 80;

/**
 * How many accepted Tool results may arrive before the plan is called stale.
 *
 * A plan describes the work; it does not stop work happening without it. Twenty-four accepted results
 * is a couple of Tool batches on a long task — far enough that the reminder is not noise, close enough
 * that the model can re-record the plan cheaply while it still remembers why. The reminder is a
 * prompt, never a gate: nothing forces a new revision, nothing marks a step verified because the plan
 * was refreshed, and the count resets only when a new revision is accepted.
 */
export const TASK_PLAN_STALE_AFTER_RESULTS = 24;

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
  const blocks = renderBoundedTaskPlanSections(snapshot, options);
  return Object.freeze({
    text: [blocks.notice, blocks.current, blocks.evidence].filter(Boolean).join("\n"),
    includedSections: blocks.includedSections,
    omittedCounts: blocks.omittedCounts,
  });
}

export function renderBoundedTaskPlanSections(
  snapshot: TaskPlanSnapshot,
  options: {
    readonly maxBytes?: number;
    readonly evidence?: readonly ResolvedTaskPlanEvidence[];
    readonly availableEvidenceRefs?: readonly TaskPlanAvailableEvidenceRef[];
  } = {},
): BoundedTaskPlanSectionsRender {
  const maxBytes = options.maxBytes ?? 8 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
    throw new RangeError("Task plan render budget must be at least 256 bytes.");
  }
  const ratio = Math.min(1, Math.max(0, (maxBytes - 8) / 8192));
  const budget = (key: keyof typeof SEMANTIC_PLAN_BUDGETS): number =>
    Math.floor(SEMANTIC_PLAN_BUDGETS[key] * ratio);
  const blockBudget = (key: keyof typeof TASK_PLAN_BLOCK_BUDGETS): number =>
    Math.floor(TASK_PLAN_BLOCK_BUDGETS[key] * ratio);
  /*
   * The three blocks are shares of one budget, not three independent caps.
   *
   * ```text
   * notice    never below the two lines that say which plan this is and what it counts
   * evidence  its share; a summary of checks, so it never grows into the notice's floor
   * current   its share, less whatever the notice floor took above its own share
   * ```
   *
   * Scaling each block by the same ratio and then joining them exceeded the total: at a 512-byte
   * budget the notice's 31-byte share could not hold its mandatory lines, and the old rule kept them
   * anyway, so the joined text was larger than the budget it promised. The notice floor is the one
   * non-negotiable part — a notice without the revision it describes describes nothing — so the
   * stable body absorbs the difference instead.
   */
  const separatorBytes = 2;
  const noticeCap = Math.min(
    maxBytes,
    Math.max(blockBudget("notice"), noticeMandatoryBytes(snapshot)),
  );
  const evidenceCap = blockBudget("evidence");
  const currentCap = Math.min(
    blockBudget("current"),
    Math.max(0, maxBytes - noticeCap - evidenceCap - separatorBytes),
  );
  const marks: Record<TaskPlanStepStatus, string> = {
    completed: "[x]",
    in_progress: "[>]",
    pending: "[ ]",
  };
  const evidenceByReference = new Map(
    (options.evidence ?? []).map((item) => [item.reference, item.state] as const),
  );
  const evidenceLabels = new Map(
    (options.availableEvidenceRefs ?? []).map(
      (item) => [item.reference, item.description] as const,
    ),
  );
  const evidenceStateOf = (step: TaskPlanStep): TaskPlanEvidenceState =>
    aggregateTaskPlanEvidenceState(step.evidenceRefs, evidenceByReference);
  /**
   * One step line, with the three facts kept apart.
   *
   * ```text
   * refs:               what the model recorded (deduplicated; a repeat cites nothing new)
   * reportedStatus=     what the model says about its own step
   * independentEvidence what the resolved facts say about the checks it cited
   * ```
   *
   * They are printed on every step, including steps that cite nothing, because a line without an
   * evidence clause would read as "not checked yet" on a step the model marked completed. Writing
   * `independentEvidence=UNVERIFIED` says that explicitly.
   */
  const stepLine = (step: TaskPlanStep): string => {
    const identity = step.id === undefined ? "" : `${step.id} `;
    const acceptance =
      step.acceptance === undefined || step.acceptance.length === 0
        ? ""
        : ` — accept: ${step.acceptance.join("; ")}`;
    const refs = uniqueReferences(step.evidenceRefs ?? []);
    const recorded = refs.length === 0 ? "refs: none" : `refs: ${refs.join(", ")}`;
    return `${marks[step.status]} ${identity}${step.step}${acceptance} [${recorded}; reportedStatus=${step.status}; independentEvidence=${evidenceStateOf(step)}]`;
  };
  const active = snapshot.steps.filter((step) => step.status === "in_progress");
  const pending = snapshot.steps.filter((step) => step.status === "pending");
  const current = active.length > 0 ? active : pending.slice(0, 1);
  const currentSet = new Set(current);
  const completed = snapshot.steps.filter((step) => step.status === "completed");
  const otherPending = pending.filter((step) => !currentSet.has(step));
  const execution = snapshot.execution;
  const counts = countEvidenceStates(snapshot.steps, evidenceStateOf);
  const citedReferences = new Set(snapshot.steps.flatMap((step) => step.evidenceRefs ?? []));
  const evidenceEntries = selectEvidenceEntries({
    current,
    completed,
    stateOf: evidenceStateOf,
    evidenceByReference,
    labels: evidenceLabels,
    cited: citedReferences,
    available: options.availableEvidenceRefs ?? [],
  });
  const evidenceSummary = evidenceSummaryLine(counts, citedReferences.size);
  const sections: SemanticPlanSection[] = [
    {
      id: "meta",
      title: `目标与版本 (plan v${snapshot.planVersion}; ${snapshot.steps.length} steps)`,
      lines: [
        ...(execution?.goal === undefined
          ? []
          : [`Recorded goal (model's words): ${execution.goal}`]),
        ...(snapshot.explanation === undefined ? [] : [`Why it changed: ${snapshot.explanation}`]),
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
      id: "evidence",
      title: `独立证据 — 仅覆盖所引用的检查 (计划引用 ${String(citedReferences.size)} 条去重引用)`,
      // The conclusion comes first so that clipping removes entries, never the judgement. A footer
      // the reader can lose is a footer that can contradict the step lines it was meant to explain.
      lines: [evidenceSummary, ...evidenceEntries],
      budget: evidenceCap,
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
        ...(execution?.discoveries ?? []).map((line) => `发现（报告）: ${line}`),
        ...(execution?.decisions ?? []).map((line) => `决定（报告）: ${line}`),
      ],
      budget: budget("remaining"),
    },
  ];

  const rendered = sections.map((section) => renderSemanticSection(section, section.budget));
  const blockText = (id: string): string =>
    rendered[sections.findIndex((section) => section.id === id)]?.text ?? "";
  const joinCurrent = (): string =>
    SEMANTIC_PLAN_SECTION_ORDER.map(blockText).filter(Boolean).join("\n");
  const clipCurrent = (value: string): string =>
    Buffer.byteLength(value, "utf8") <= currentCap
      ? value
      : truncateUtf8(value, currentCap, "current", SEMANTIC_PLAN_SECTION_ORDER.length).text;
  // Section budgets exclude the newline that joins them, so the joined block is measured as a whole
  // and clipped once if the separators pushed it over its cap.
  let currentText = clipCurrent(joinCurrent());
  // Unused capacity in sparse sections is borrowed by the highest-priority sections first. Each
  // section is re-rendered from the original source, so borrowing cannot stack lossy truncations, and
  // the block cap is the hard bound: borrowing never makes the `current` block larger than its share.
  let remaining = Math.max(0, currentCap - Buffer.byteLength(currentText, "utf8"));
  for (const id of SEMANTIC_PLAN_SECTION_ORDER) {
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
  }
  currentText = clipCurrent(joinCurrent());
  const notice = renderTaskPlanNotice(snapshot, noticeCap);
  const includedSections = [
    ...SEMANTIC_PLAN_SECTION_ORDER.filter((id) => blockText(id).length > 0),
    ...(blockText("evidence").length > 0 ? ["evidence"] : []),
    ...(notice.text.length > 0 ? ["notice"] : []),
  ];
  const omittedCounts = Object.fromEntries([
    ...rendered
      .filter((entry) => entry.omittedCount > 0)
      .map((entry) => [entry.id, entry.omittedCount] as const),
    ...(notice.omittedCount > 0 ? ([["notice", notice.omittedCount]] as const) : []),
  ]);
  return Object.freeze({
    current: currentText,
    evidence: blockText("evidence"),
    notice: notice.text,
    includedSections: Object.freeze(includedSections),
    omittedCounts: Object.freeze(omittedCounts),
  });
}

/**
 * The two lines the notice cannot do without, and the only part of it that is not optional.
 *
 * `identity` says which revision this Context describes; `counts` says how much work has been
 * accepted since it was recorded and how much of it the model reports as done. Both are reports about
 * the record. They are separate from the rest so that the budget planner can reserve their exact byte
 * size before deciding how much room the stable body gets.
 */
function noticeMandatoryLines(snapshot: TaskPlanSnapshot): readonly string[] {
  const completed = snapshot.steps.filter((step) => step.status === "completed").length;
  return [
    `CURRENT PLAN v${String(snapshot.planVersion)} — bounded accepted working projection; a completed mark is a report, not proof.`,
    `报告完成 ${String(completed)}/${String(snapshot.steps.length)}; accepted Tool results since plan: ${String(snapshot.resultsSincePlan)}. Activity is not verification.`,
  ];
}

function noticeMandatoryBytes(snapshot: TaskPlanSnapshot): number {
  return Buffer.byteLength(noticeMandatoryLines(snapshot).join("\n"), "utf8");
}

/**
 * The volatile block: which revision this is, what the completion count says, and what the record
 * itself is missing.
 *
 * ```text
 * identity             first      which revision this Context describes
 * counts               second     reported completion, accepted work since
 * UPDATE_REJECTED      when a later update_plan was refused and discarded
 * STALE                when the work outgrew the plan without a new revision
 * reference            when it fits: how to find the complete durable snapshot
 * ```
 *
 * It exists so the stable body can stay byte-identical while those numbers move. Every line here is a
 * report about the record, never a conclusion about the project, and nothing here marks a step done —
 * a refreshed plan is still a report, and a stale one is still the last accepted list.
 */
function renderTaskPlanNotice(
  snapshot: TaskPlanSnapshot,
  maxBytes: number,
): { readonly text: string; readonly omittedCount: number } {
  const rejected = snapshot.rejectedUpdate;
  const lines = [
    ...noticeMandatoryLines(snapshot),
    ...(rejected === undefined
      ? []
      : [
          `UPDATE_REJECTED ${rejected.reason}: your last update_plan was refused, so nothing was recorded; the plan in this Context is still the current one.`,
        ]),
    ...(snapshot.resultsSincePlan < TASK_PLAN_STALE_AFTER_RESULTS
      ? []
      : [
          `STALE: ${String(snapshot.resultsSincePlan)} accepted Tool results since this revision and no newer plan. Re-record it if the work moved on; keep it if it still holds.`,
        ]),
    `Full snapshot reference: revision=${snapshot.revision}; sourceStep=${snapshot.sourceStepId ?? "unknown"}. The complete accepted plan remains in durable conversation history.`,
  ];
  return assembleNotice(lines, maxBytes);
}

/**
 * Fit the notice into its byte budget by dropping whole lines, never by cutting one.
 *
 * The first two lines are the record itself — which plan this is and what it counts — and they are
 * kept ahead of everything else: a notice that loses the revision it describes is worse than no
 * notice. The rest are added while they fit, in the order they change a decision, and the ones that
 * do not fit are counted. A half-sentence ending is what the previous truncation produced, and a
 * reader cannot tell a clipped reminder from a complete one.
 *
 * The budget is a hard bound, so when even the two mandatory lines do not fit — a budget the planner
 * avoids by reserving their size up front, but which a direct caller can still ask for — the identity
 * line survives as a marked truncation and everything else is counted as omitted.
 */
function assembleNotice(
  lines: readonly string[],
  maxBytes: number,
): { readonly text: string; readonly omittedCount: number } {
  const mandatory = Math.min(2, lines.length);
  const kept: string[] = [];
  let omittedCount = 0;
  for (const [index, line] of lines.entries()) {
    const candidate = [...kept, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      kept.push(line);
      continue;
    }
    /*
     * The mandatory lines are privileged in the order they are offered, not beyond the budget: they
     * are tried first and never dropped to make room for a later, optional line. If the budget cannot
     * hold even the first one, the marked truncation below is the honest answer — silently exceeding
     * the cap is not.
     */
    if (index < mandatory && kept.length === 0) {
      return {
        text: truncateUtf8(line, maxBytes, "notice", lines.length).text,
        omittedCount: Math.max(1, lines.length - 1),
      };
    }
    omittedCount += 1;
  }
  return { text: kept.join("\n"), omittedCount };
}

function uniqueReferences(references: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(references)]);
}

function countEvidenceStates(
  steps: readonly TaskPlanStep[],
  stateOf: (step: TaskPlanStep) => TaskPlanEvidenceState,
): Readonly<Record<TaskPlanEvidenceState, number>> {
  const counts: Record<TaskPlanEvidenceState, number> = {
    PASSED: 0,
    FAILED: 0,
    STALE: 0,
    INCOMPLETE: 0,
    UNKNOWN: 0,
    UNVERIFIED: 0,
  };
  for (const step of steps) counts[stateOf(step)] += 1;
  return counts;
}

/**
 * The one sentence that says what the evidence covers.
 *
 * ```text
 * cited nothing       counts, and the fact that every completed mark is only a report
 * cited something     counts, whether any cited check has passed, and what the counts cover
 * ```
 *
 * Neither branch concludes that the work is done. A count of PASSED steps is a statement about the
 * checks the model chose to cite, not about the project: the projection cannot see requirements the
 * plan never wrote down.
 */
function evidenceSummaryLine(
  counts: Readonly<Record<TaskPlanEvidenceState, number>>,
  distinctReferences: number,
): string {
  const perState = (["PASSED", "FAILED", "STALE", "INCOMPLETE", "UNKNOWN", "UNVERIFIED"] as const)
    .map((state) => `${state} ${String(counts[state])}`)
    .join(" / ");
  if (distinctReferences === 0) {
    return `按步骤统计: ${perState}. 计划未记录检查引用；completed 只是模型报告，不构成全部需求完成的结论.`;
  }
  const passNote =
    counts.PASSED === 0
      ? "；没有任何所引用检查通过"
      : `；${String(counts.PASSED)} 个步骤的引用检查通过`;
  return `按步骤统计: ${perState}${passNote}. 仅覆盖所引用的检查，不构成全部需求完成的结论.`;
}

/**
 * Choose at most four references to print.
 *
 * ```text
 * 1. what the current step cites                    what the next action is about to need
 * 2. failed or stale references of completed steps  what must be repaired, not repeated
 * 3. other completed steps' references             the evidence the plan already relies on
 * 4. the most recent available real references      what the model can cite next
 * ```
 *
 * Tier 3 exists because a plan that cites only passing checks would otherwise print a summary and no
 * references at all — the section would be at its least useful exactly when the work is going well.
 *
 * Unknown references are printed as UNKNOWN rather than resolved by guessing an id from model prose,
 * and the model's plan is never edited to add references it did not record.
 */
function selectEvidenceEntries(input: {
  readonly current: readonly TaskPlanStep[];
  readonly completed: readonly TaskPlanStep[];
  readonly stateOf: (step: TaskPlanStep) => TaskPlanEvidenceState;
  readonly evidenceByReference: ReadonlyMap<string, TaskPlanEvidenceState>;
  readonly labels: ReadonlyMap<string, string>;
  readonly cited: ReadonlySet<string>;
  readonly available: readonly TaskPlanAvailableEvidenceRef[];
}): readonly string[] {
  const entries: string[] = [];
  const included = new Set<string>();
  const add = (reference: string): void => {
    if (included.has(reference) || entries.length >= MAX_EVIDENCE_ENTRIES) return;
    included.add(reference);
    const label = input.labels.get(reference);
    /**
     * `- <reference> — <description> [<state>]`.
     *
     * The state is printed only when the plan cites the reference: an available reference the plan
     * never cited has no state *for this plan*, and printing `[UNKNOWN]` there would claim a
     * resolution was attempted and failed. The description is dropped rather than filled with a
     * placeholder when the host has no label for it — the reference token, which is what the model
     * copies into `evidenceRefs`, is the part that must stay intact.
     */
    const state = input.cited.has(reference)
      ? (input.evidenceByReference.get(reference) ?? "UNKNOWN")
      : undefined;
    const description =
      label === undefined ? "" : ` — ${clipUtf8(label, EVIDENCE_DESCRIPTION_BYTES)}`;
    entries.push(
      state === undefined
        ? `- ${reference}${description}`
        : `- ${reference}${description} [${state}]`,
    );
  };
  for (const step of input.current) for (const reference of step.evidenceRefs ?? []) add(reference);
  const needsRepair = input.completed.filter((step) => {
    const state = input.stateOf(step);
    return state === "FAILED" || state === "STALE";
  });
  const repaired = new Set(needsRepair);
  for (const step of needsRepair) for (const reference of step.evidenceRefs ?? []) add(reference);
  // Later steps are the more recent record of what the plan relies on.
  for (const step of [...input.completed].reverse()) {
    if (repaired.has(step)) continue;
    for (const reference of step.evidenceRefs ?? []) add(reference);
  }
  // Most recent first: the adapter hands over ascending history, so the tail is the newest.
  for (const item of [...input.available].reverse()) add(item.reference);
  return Object.freeze(entries);
}

/**
 * Clip to a byte budget without splitting a character, marking that something was removed.
 *
 * A budget that can be exceeded by one character is not a budget, and a description that lies about
 * being complete is worse than one that ends in an ellipsis.
 */
function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const ellipsis = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"));
  let used = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) break;
    used += size;
    end += character.length;
  }
  return `${value.slice(0, end)}${ellipsis}`;
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
