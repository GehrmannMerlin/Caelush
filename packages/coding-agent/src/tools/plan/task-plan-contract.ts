/**
 * The one parser for `update_plan` arguments, and the bounds it enforces.
 *
 * ```text
 * V1   { plan: [{ step, status }] }
 * V2   { planVersion: 2, plan: [{ id, step, status, acceptance?, evidenceRefs? }],
 *        explanation?, execution? }
 * ```
 *
 * ## Why one parser and not two schemas
 *
 * A Tool handler, a projection and a test all have to agree on what a plan *is*. The pre-v2 code had a
 * validator inside the Tool and the projection called back into it, which is the right instinct; what
 * was missing was a version. So the flat input schema declares the union of the fields, and this
 * parser applies the conditional rules — which fields require `planVersion: 2`, and which are refused
 * without it — in exactly one place.
 *
 * A flat schema plus conditional validation is deliberate: providers differ in how well they support
 * `oneOf`, and a Tool whose arguments a provider cannot describe is a Tool the model cannot call
 * reliably. The conditionality belongs in code that runs on every provider, not in a schema some of
 * them will fail to use well.
 *
 * ## What V2 adds and what it deliberately does not
 *
 * ```text
 * explanation   why the list or the understanding changed — one short sentence, not a narrative
 * id            a stable handle, so "the same step, reordered" is distinguishable from "a new step"
 * acceptance    what observable result would make this step done
 * evidenceRefs  what the model believes shows it; a claim, rendered as a claim until something
 *               independent checks it
 * execution     the current working record: goal, constraints, findings, decisions, unresolved
 *               failures and the next action, as a full replacement snapshot
 * ```
 *
 * It does not add a plan table, a Markdown mirror, a second executor, or a mutable step tree. The
 * accepted `update_plan` call and result remain the only record, and every read is a projection of it.
 */

/** A step's declared state. The three-valued form is the client contract and is not extended. */
export type TaskPlanStepStatus = "pending" | "in_progress" | "completed";

/**
 * What one step looks like after parsing.
 *
 * V1 produces `{ step, status }` exactly as before, so a client that only understands the v1 shape
 * keeps working; the optional fields are present only for a v2 plan that declared them.
 */
export interface TaskPlanStep {
  readonly id?: string;
  readonly step: string;
  readonly status: TaskPlanStepStatus;
  readonly acceptance?: readonly string[];
  readonly evidenceRefs?: readonly string[];
}

/**
 * The bounded long-horizon working record.
 *
 * Every field is a *current snapshot*, not a log: it replaces the previous one, which is what keeps it
 * bounded by construction rather than by truncation. `unresolved` is the field that stops a plan from
 * looking finished while a real failure is still open.
 */
export interface TaskPlanExecution {
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly discoveries?: readonly string[];
  readonly decisions?: readonly string[];
  readonly unresolved?: readonly string[];
  readonly nextAction?: string;
}

/** A parsed, accepted-shape plan. */
export interface TaskPlan {
  readonly planVersion: 1 | 2;
  readonly steps: readonly TaskPlanStep[];
  readonly explanation?: string;
  readonly execution?: TaskPlanExecution;
}

export type TaskPlanParseResult =
  { readonly ok: true; readonly plan: TaskPlan } | { readonly ok: false; readonly reason: string };

/**
 * The bounds, in one object so a test can assert them and a caller can cite them.
 *
 * They are *inputs*, validated before anything is stored. An over-limit plan is refused with a
 * field-specific reason so the model can send a smaller one; it is never silently truncated, because a
 * truncated plan is a plan the model did not write and cannot reason about.
 */
export const TASK_PLAN_LIMITS = Object.freeze({
  maxSteps: 20,
  maxStepChars: 200,
  maxAcceptancePerStep: 3,
  maxAcceptanceChars: 240,
  maxEvidenceRefsPerStep: 4,
  maxEvidenceRefChars: 160,
  maxStepIdChars: 64,
  maxExplanationChars: 800,
  maxGoalChars: 1_000,
  maxWorkingItems: 8,
  maxWorkingItemChars: 300,
  maxNextActionChars: 500,
  /** The whole argument object, in UTF-8 bytes. */
  maxTotalBytes: 32 * 1024,
});

const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/**
 * The fields that only make sense in a versioned plan.
 *
 * Their presence without `planVersion: 2` is refused rather than guessed at: an unversioned object
 * interpreted by two parsers is exactly the ambiguity the version exists to remove.
 */
const V2_ONLY_STEP_FIELDS = ["id", "acceptance", "evidenceRefs"] as const;

/**
 * Parse `update_plan` arguments into the plan they describe.
 *
 * The order of the checks is the order of the feedback a model should get: version coherence, then
 * structure, then per-field bounds, then the cross-field rule that would make a plan ambiguous. A
 * reason codes the first thing that is wrong, because a model that is told six things at once fixes
 * none of them.
 */
export function parseTaskPlanInput(value: unknown): TaskPlanParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "PLAN_ARGUMENTS_NOT_AN_OBJECT" };
  }
  const record = value as Record<string, unknown>;
  if (byteLengthOf(record) > TASK_PLAN_LIMITS.maxTotalBytes) {
    return { ok: false, reason: "PLAN_TOO_LARGE" };
  }
  const declaredVersion = record["planVersion"];
  if (declaredVersion !== undefined && declaredVersion !== 2) {
    return { ok: false, reason: "PLAN_VERSION_UNSUPPORTED" };
  }
  const isV2 = declaredVersion === 2;
  if (!isV2) {
    // `execution` is the top-level v2-only field; the step-level ones are checked below.
    if (record["execution"] !== undefined) return { ok: false, reason: "PLAN_VERSION_REQUIRED" };
    const rawSteps = record["plan"];
    if (Array.isArray(rawSteps)) {
      for (const entry of rawSteps) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        for (const field of V2_ONLY_STEP_FIELDS) {
          if ((entry as Record<string, unknown>)[field] !== undefined) {
            return { ok: false, reason: "PLAN_VERSION_REQUIRED" };
          }
        }
      }
    }
  }
  const explanation = record["explanation"];
  if (explanation !== undefined) {
    if (typeof explanation !== "string") return { ok: false, reason: "EXPLANATION_INVALID" };
    if (explanation.length > TASK_PLAN_LIMITS.maxExplanationChars) {
      return { ok: false, reason: "EXPLANATION_TOO_LONG" };
    }
  }

  const steps = parseSteps(record["plan"], isV2);
  if (!steps.ok) return steps;

  if (isV2) {
    const seen = new Set<string>();
    for (const step of steps.steps) {
      if (step.id === undefined) return { ok: false, reason: "STEP_ID_REQUIRED" };
      if (seen.has(step.id)) return { ok: false, reason: "STEP_ID_DUPLICATE" };
      seen.add(step.id);
    }
  }

  const execution = isV2
    ? parseExecution(record["execution"])
    : { ok: true as const, value: undefined };
  if (!execution.ok) return execution;

  return {
    ok: true,
    plan: Object.freeze({
      planVersion: isV2 ? (2 as const) : (1 as const),
      steps: steps.steps,
      ...(explanation === undefined ? {} : { explanation: explanation.trim() }),
      ...(execution.value === undefined ? {} : { execution: execution.value }),
    }),
  };
}

function parseSteps(
  value: unknown,
  isV2: boolean,
):
  | { readonly ok: true; readonly steps: readonly TaskPlanStep[] }
  | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "PLAN_NOT_A_LIST" };
  if (value.length === 0) return { ok: false, reason: "PLAN_EMPTY" };
  if (value.length > TASK_PLAN_LIMITS.maxSteps) return { ok: false, reason: "PLAN_TOO_LONG" };
  const steps: TaskPlanStep[] = [];
  let inProgress = 0;
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: "STEP_NOT_AN_OBJECT" };
    }
    const record = entry as Record<string, unknown>;
    const step = record["step"];
    const status = record["status"];
    if (
      typeof step !== "string" ||
      step.trim().length === 0 ||
      step.length > TASK_PLAN_LIMITS.maxStepChars
    ) {
      return { ok: false, reason: "STEP_TEXT_INVALID" };
    }
    if (typeof status !== "string" || !STEP_STATUSES.has(status)) {
      return { ok: false, reason: "STEP_STATUS_INVALID" };
    }
    if (status === "in_progress") inProgress += 1;
    const id = readStepId(record["id"]);
    if (id !== undefined && id.ok === false) return { ok: false, reason: id.reason };
    const acceptance = readStringList(record["acceptance"], {
      max: TASK_PLAN_LIMITS.maxAcceptancePerStep,
      maxChars: TASK_PLAN_LIMITS.maxAcceptanceChars,
      tooMany: "ACCEPTANCE_TOO_MANY",
      tooLong: "ACCEPTANCE_TOO_LONG",
      invalid: "ACCEPTANCE_INVALID",
    });
    if (!acceptance.ok) return { ok: false, reason: acceptance.reason };
    const evidenceRefs = readStringList(record["evidenceRefs"], {
      max: TASK_PLAN_LIMITS.maxEvidenceRefsPerStep,
      maxChars: TASK_PLAN_LIMITS.maxEvidenceRefChars,
      tooMany: "EVIDENCE_REFS_TOO_MANY",
      tooLong: "EVIDENCE_REF_TOO_LONG",
      invalid: "EVIDENCE_REFS_INVALID",
    });
    if (!evidenceRefs.ok) return { ok: false, reason: evidenceRefs.reason };
    if (!isV2 && id !== undefined) return { ok: false, reason: "PLAN_VERSION_REQUIRED" };
    steps.push(
      Object.freeze({
        ...(id === undefined ? {} : { id: id.value }),
        step: step.trim(),
        status: status as TaskPlanStepStatus,
        ...(acceptance.values === undefined ? {} : { acceptance: acceptance.values }),
        ...(evidenceRefs.values === undefined ? {} : { evidenceRefs: evidenceRefs.values }),
      }),
    );
  }
  if (inProgress > 1) return { ok: false, reason: "MULTIPLE_IN_PROGRESS" };
  return { ok: true, steps: Object.freeze(steps) };
}

function parseExecution(
  value: unknown,
):
  | { readonly ok: true; readonly value: TaskPlanExecution | undefined }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "EXECUTION_INVALID" };
  }
  const record = value as Record<string, unknown>;
  const goal = record["goal"];
  if (goal !== undefined) {
    if (typeof goal !== "string" || goal.length > TASK_PLAN_LIMITS.maxGoalChars) {
      return { ok: false, reason: "EXECUTION_GOAL_INVALID" };
    }
  }
  const lists: Record<"constraints" | "discoveries" | "decisions" | "unresolved", string[]> = {
    constraints: [],
    discoveries: [],
    decisions: [],
    unresolved: [],
  };
  for (const key of ["constraints", "discoveries", "decisions", "unresolved"] as const) {
    const parsed = readStringList(record[key], {
      max: TASK_PLAN_LIMITS.maxWorkingItems,
      maxChars: TASK_PLAN_LIMITS.maxWorkingItemChars,
      tooMany: "EXECUTION_LIST_TOO_LONG",
      tooLong: "EXECUTION_ITEM_TOO_LONG",
      invalid: "EXECUTION_ITEM_INVALID",
    });
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    if (parsed.values !== undefined) lists[key] = [...parsed.values];
  }
  const nextAction = record["nextAction"];
  if (nextAction !== undefined) {
    if (typeof nextAction !== "string" || nextAction.length > TASK_PLAN_LIMITS.maxNextActionChars) {
      return { ok: false, reason: "EXECUTION_NEXT_ACTION_INVALID" };
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...(goal === undefined ? {} : { goal: goal.trim() }),
      ...(lists.constraints.length === 0 ? {} : { constraints: Object.freeze(lists.constraints) }),
      ...(lists.discoveries.length === 0 ? {} : { discoveries: Object.freeze(lists.discoveries) }),
      ...(lists.decisions.length === 0 ? {} : { decisions: Object.freeze(lists.decisions) }),
      ...(lists.unresolved.length === 0 ? {} : { unresolved: Object.freeze(lists.unresolved) }),
      ...(nextAction === undefined ? {} : { nextAction: nextAction.trim() }),
    }),
  };
}

function readStepId(
  value: unknown,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string }
  | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > TASK_PLAN_LIMITS.maxStepIdChars
  ) {
    return { ok: false, reason: "STEP_ID_INVALID" };
  }
  return { ok: true, value: value.trim() };
}

function readStringList(
  value: unknown,
  bounds: {
    readonly max: number;
    readonly maxChars: number;
    readonly tooMany: string;
    readonly tooLong: string;
    readonly invalid: string;
  },
):
  | { readonly ok: true; readonly values?: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, reason: bounds.invalid };
  if (value.length > bounds.max) return { ok: false, reason: bounds.tooMany };
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return { ok: false, reason: bounds.invalid };
    }
    if (entry.length > bounds.maxChars) return { ok: false, reason: bounds.tooLong };
    values.push(entry.trim());
  }
  return values.length === 0 ? { ok: true } : { ok: true, values: Object.freeze(values) };
}

function byteLengthOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * What a model should do about each rejection, and nothing about what it sent.
 *
 * ## Why the reason code alone is not enough
 *
 * A rejection is the one Tool result that costs the model an entire plan: the payload it composed is
 * discarded, and it has to compose another. `Tool operation failed: PLAN_VERSION_REQUIRED.` tells it
 * that something was wrong and leaves it guessing which field, so a real Run repeated the same
 * rejected call until its budget ran out. The reason code is a fact for the host; the model needs the
 * *correction*.
 *
 * ## Why nothing is echoed back
 *
 * The fix names fields, not values: `planVersion`, `id`, `plan[].status`. A rejected payload can
 * contain anything the model saw — file paths, command output, user text — and a refusal is not a
 * reason to re-print it into the conversation, into a log, or into a support bundle. The correction is
 * a fixed sentence per code, so its size and its content are known before the call is made.
 */
const TASK_PLAN_REJECTION_GUIDANCE: Readonly<Record<string, TaskPlanRejectionGuidance>> = Object.freeze(
  {
    PLAN_ARGUMENTS_NOT_AN_OBJECT: {
      problem: "The arguments were not a JSON object with a `plan` array.",
      fix: 'Send `{ "plan": [ ... ] }`, optionally with `planVersion: 2`, `explanation` and `execution`.',
    },
    PLAN_TOO_LARGE: {
      problem: `The argument object was larger than ${String(TASK_PLAN_LIMITS.maxTotalBytes)} bytes.`,
      fix: "Shorten the step text, the acceptance items, the evidence references and the working record; the plan is a summary, not a document.",
    },
    PLAN_VERSION_UNSUPPORTED: {
      problem: "`planVersion` was present and was not 2. A plain checklist is expressed by omitting it.",
      fix: "Omit `planVersion` for a v1 checklist, or send exactly `planVersion: 2`.",
    },
    PLAN_VERSION_REQUIRED: {
      problem:
        "`id`, `acceptance`, `evidenceRefs` and a top-level `execution` are plan v2 fields, and this call did not declare `planVersion: 2`.",
      fix: "Resend the complete plan with `planVersion: 2` at the top level and a unique `id` on every step.",
    },
    EXPLANATION_INVALID: {
      problem: "`explanation` was not a string.",
      fix: "Send one short sentence naming what changed, or omit the field.",
    },
    EXPLANATION_TOO_LONG: {
      problem: `\`explanation\` was longer than ${String(TASK_PLAN_LIMITS.maxExplanationChars)} characters.`,
      fix: "Reduce it to one sentence that names what changed.",
    },
    PLAN_NOT_A_LIST: {
      problem: "`plan` was not an array.",
      fix: "Send the complete step list as an array of step objects.",
    },
    PLAN_EMPTY: {
      problem: "`plan` contained no steps.",
      fix: "Send at least one step; a plan with no steps records nothing.",
    },
    PLAN_TOO_LONG: {
      problem: `\`plan\` had more than ${String(TASK_PLAN_LIMITS.maxSteps)} steps.`,
      fix: "Group related milestones so the list fits the step limit.",
    },
    STEP_NOT_AN_OBJECT: {
      problem: "A step in `plan` was not an object.",
      fix: 'Send each step as `{ "step": ..., "status": ... }` with the optional v2 fields.',
    },
    STEP_TEXT_INVALID: {
      problem: `A step's \`step\` was empty, not a string, or longer than ${String(TASK_PLAN_LIMITS.maxStepChars)} characters.`,
      fix: "Give the step one short, verifiable sentence.",
    },
    STEP_STATUS_INVALID: {
      problem: "A step's `status` was not `pending`, `in_progress` or `completed`.",
      fix: "Use exactly one of those three values.",
    },
    STEP_ID_INVALID: {
      problem: `A step's \`id\` was empty, not a string, or longer than ${String(TASK_PLAN_LIMITS.maxStepIdChars)} characters.`,
      fix: "Use a short stable handle such as `editor` or `tests`.",
    },
    STEP_ID_REQUIRED: {
      problem: "A step in a v2 plan had no `id`.",
      fix: "Give every step a unique `id`; ids are what keep a reordered list comparable.",
    },
    STEP_ID_DUPLICATE: {
      problem: "Two steps declared the same `id`.",
      fix: "Make every `id` unique within the plan.",
    },
    ACCEPTANCE_TOO_MANY: {
      problem: `A step had more than ${String(TASK_PLAN_LIMITS.maxAcceptancePerStep)} acceptance items.`,
      fix: "Keep at most three observable results per step.",
    },
    ACCEPTANCE_TOO_LONG: {
      problem: `An acceptance item was longer than ${String(TASK_PLAN_LIMITS.maxAcceptanceChars)} characters.`,
      fix: "Shorten it to the observable result that would make the step done.",
    },
    ACCEPTANCE_INVALID: {
      problem: "`acceptance` was not an array of non-empty strings.",
      fix: "Send an array of strings, or omit the field.",
    },
    EVIDENCE_REFS_TOO_MANY: {
      problem: `A step cited more than ${String(TASK_PLAN_LIMITS.maxEvidenceRefsPerStep)} evidence references.`,
      fix: "Cite at most four references per step.",
    },
    EVIDENCE_REF_TOO_LONG: {
      problem: `An evidence reference was longer than ${String(TASK_PLAN_LIMITS.maxEvidenceRefChars)} characters.`,
      fix: "Cite the reference token exactly as it was published, without commentary.",
    },
    EVIDENCE_REFS_INVALID: {
      problem: "`evidenceRefs` was not an array of non-empty strings.",
      fix: "Send an array of reference strings, or omit the field.",
    },
    MULTIPLE_IN_PROGRESS: {
      problem: "More than one step was marked `in_progress`.",
      fix: "Mark at most one step `in_progress` and mark the others `pending` or `completed`.",
    },
    EXECUTION_INVALID: {
      problem: "`execution` was not an object.",
      fix: "Send it as an object with the working record fields, or omit it.",
    },
    EXECUTION_GOAL_INVALID: {
      problem: `\`execution.goal\` was not a string or was longer than ${String(TASK_PLAN_LIMITS.maxGoalChars)} characters.`,
      fix: "Reduce it to a short statement of the goal.",
    },
    EXECUTION_LIST_TOO_LONG: {
      problem: `An \`execution\` list had more than ${String(TASK_PLAN_LIMITS.maxWorkingItems)} items.`,
      fix: "Keep only what the next action needs; the record is a snapshot, not a log.",
    },
    EXECUTION_ITEM_TOO_LONG: {
      problem: `An \`execution\` item was longer than ${String(TASK_PLAN_LIMITS.maxWorkingItemChars)} characters.`,
      fix: "Shorten the item to the fact itself.",
    },
    EXECUTION_ITEM_INVALID: {
      problem: "An `execution` list item was not a non-empty string.",
      fix: "Send each item as a non-empty string.",
    },
    EXECUTION_NEXT_ACTION_INVALID: {
      problem: `\`execution.nextAction\` was not a string or was longer than ${String(TASK_PLAN_LIMITS.maxNextActionChars)} characters.`,
      fix: "State the next concrete action in one sentence.",
    },
  },
);

export interface TaskPlanRejectionGuidance {
  /** What was wrong, in terms of the contract's fields. */
  readonly problem: string;
  /** The exact next action that would be accepted. */
  readonly fix: string;
}

/** The corrective guidance for a rejection code, with a safe fallback for an unknown one. */
export function describeTaskPlanRejection(reason: string): TaskPlanRejectionGuidance {
  const known = Object.hasOwn(TASK_PLAN_REJECTION_GUIDANCE, reason)
    ? TASK_PLAN_REJECTION_GUIDANCE[reason]
    : undefined;
  if (known !== undefined) return known;
  return {
    problem: "The arguments did not match the `update_plan` contract.",
    fix: "Resend the complete plan using the documented field names.",
  };
}

/**
 * Render a rejected plan as the text the model reads on its next turn.
 *
 * ```text
 * Tool operation failed: PLAN_VERSION_REQUIRED.
 * <what was wrong, named by field>
 * Fix: <the correction that would be accepted>
 * Nothing was recorded. The plan you recorded earlier, if any, is still the current one.
 * ```
 *
 * The last line is the one that matters most after a rejection: the model does not know whether its
 * call partially applied, so it may either resend a duplicate or assume its plan was lost. A refusal
 * writes nothing, and saying so is what makes the next call a correction instead of a guess.
 */
export function renderTaskPlanRejection(reason: string): string {
  const guidance = describeTaskPlanRejection(reason);
  return [
    `Tool operation failed: ${reason}.`,
    guidance.problem,
    `Fix: ${guidance.fix}`,
    "Nothing was recorded. The plan you recorded earlier, if any, is still the current one.",
  ].join("\n");
}
