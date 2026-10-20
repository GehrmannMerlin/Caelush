import type { CodingToolDefinition } from "../coding-tool-definition.js";
import { UPDATE_PLAN_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { asOverlaySecurityFactsProjector } from "./result.js";
import { defineCodingTool } from "./define-coding-tool.js";
import { errorResult, successResult, type AgentToolResult } from "./result.js";

/**
 * `update_plan` — publish the current step list as data.
 *
 * ## Why this is a Tool and not a prompt sentence
 *
 * A plan in prose is unrecoverable: after a compaction or a restart nothing can tell which step was
 * current, and a model that "remembers" it is guessing. A Tool call is different in exactly the way
 * that matters — its result is a durable message, so the plan can be re-derived from accepted facts
 * and survives the same boundaries every other fact survives.
 *
 * ## What it deliberately does not do
 *
 * ```text
 * no database write         the TOOL_RESULT is the record
 * no durable event          no second event source
 * no Run transition         a completed list does not complete a Run
 * no execution              the handler only validates and echoes
 * ```
 *
 * Completion stays with the Run Controller. A model that marks every step completed has reported its
 * own opinion; the verification and completion authorities decide whether the work is done.
 *
 * ## Full replacement, linear steps
 *
 * Each call replaces the whole list. That keeps the plan a single value with one revision (the id of
 * the message that carried it) instead of a mutable tree that two writers could interleave. Nested
 * plans, dependencies and scheduling are out of scope on purpose: the harness needs a checklist the
 * model can keep honest, not a second executor.
 */
const MAX_STEPS = 20;
const MAX_STEP_CHARS = 200;

const inputSchema = {
  type: "object",
  properties: {
    plan: {
      type: "array",
      minItems: 1,
      maxItems: MAX_STEPS,
      description: "The complete step list, replacing any previous plan.",
      items: {
        type: "object",
        properties: {
          step: {
            type: "string",
            minLength: 1,
            maxLength: MAX_STEP_CHARS,
            description: "One verifiable milestone.",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "At most one step may be in_progress.",
          },
        },
        required: ["step", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["plan"],
  additionalProperties: false,
} as const;

const resultDetailsSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    total: { type: "integer", minimum: 0 },
    completed: { type: "integer", minimum: 0 },
    inProgress: { type: "integer", minimum: 0 },
    error: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

export interface PlanStep {
  readonly step: string;
  readonly status: "pending" | "in_progress" | "completed";
}

/** Validate a declared plan, returning a reason instead of throwing. */
export function validatePlanSteps(value: unknown):
  | {
      readonly ok: true;
      readonly steps: readonly PlanStep[];
    }
  | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "PLAN_NOT_A_LIST" };
  if (value.length === 0) return { ok: false, reason: "PLAN_EMPTY" };
  if (value.length > MAX_STEPS) return { ok: false, reason: "PLAN_TOO_LONG" };
  const steps: PlanStep[] = [];
  let inProgress = 0;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "STEP_NOT_AN_OBJECT" };
    }
    const record = entry as Record<string, unknown>;
    const step = record["step"];
    const status = record["status"];
    if (typeof step !== "string" || step.trim().length === 0 || step.length > MAX_STEP_CHARS) {
      return { ok: false, reason: "STEP_TEXT_INVALID" };
    }
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      return { ok: false, reason: "STEP_STATUS_INVALID" };
    }
    if (status === "in_progress") inProgress += 1;
    steps.push({ step: step.trim(), status });
  }
  if (inProgress > 1) return { ok: false, reason: "MULTIPLE_IN_PROGRESS" };
  return { ok: true, steps: Object.freeze(steps) };
}

/** Render a plan as the short text a model reads back. */
export function renderPlanSteps(steps: readonly PlanStep[]): string {
  const marks = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;
  return steps.map((step) => `${marks[step.status]} ${step.step}`).join("\n");
}

export function createUpdatePlanTool(): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "update_plan",
    description: "Record the current step list.",
    inputSchema,
    resultDetailsSchema,
    execute: async (input): Promise<AgentToolResult> => {
      const validated = validatePlanSteps(input.args["plan"]);
      if (!validated.ok) {
        return errorResult("INVALID_PLAN", `Tool operation failed: ${validated.reason}.`);
      }
      const completed = validated.steps.filter((step) => step.status === "completed").length;
      const inProgress = validated.steps.filter((step) => step.status === "in_progress").length;
      return successResult(renderPlanSteps(validated.steps), {
        total: validated.steps.length,
        completed,
        inProgress,
      });
    },
  });

  return {
    tool,
    // Pure bookkeeping: no filesystem, no process, no capability. The Tool mutates nothing but the
    // model's own declared intent, and that intent becomes durable through the ordinary Tool result.
    security: {
      riskLevel: "LOW",
      requiredCapabilities: [],
      runtimeRequirements: { runtimeKinds: [] },
    },
    // The projector is present because every Tool that reaches admission must describe its own
    // effects; this one has none. Declaring "nothing is accessed" is a fact, not an omission, and it
    // keeps the host's coverage self-check meaningful for the Tools that really do touch the host.
    securityFactsProjector: asOverlaySecurityFactsProjector(() => ({
      resourceAccesses: [],
      secretScanInputs: [],
      structuralPreview: { kind: "GENERIC", purpose: "PLAN" },
    })),
    promptSnippet: UPDATE_PLAN_PROMPT_SNIPPET,
  };
}
