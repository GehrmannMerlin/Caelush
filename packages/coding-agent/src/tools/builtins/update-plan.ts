import type { CodingToolDefinition } from "../coding-tool-definition.js";
import {
  parseTaskPlanInput,
  TASK_PLAN_LIMITS,
  type TaskPlan,
} from "../plan/task-plan-contract.js";
import { UPDATE_PLAN_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { asOverlaySecurityFactsProjector } from "./result.js";
import { defineCodingTool } from "./define-coding-tool.js";
import { errorResult, successResult, type AgentToolResult } from "./result.js";

/**
 * `update_plan` — publish the current milestone list and working record as data.
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
 * ## One parser, two versions
 *
 * The argument shape and every bound live in `task-plan-contract.ts`, and this handler is a thin
 * caller of it. `planVersion: 2` adds a stable step id, per-step acceptance, evidence references and a
 * bounded `execution` working record; a payload without it is the v1 checklist and keeps working
 * unchanged. The version is *required* as soon as any v2-only field appears, because an unversioned
 * object that two parsers could read differently is exactly the ambiguity a version removes.
 */
const inputSchema = {
  type: "object",
  properties: {
    planVersion: {
      type: "integer",
      enum: [2],
      description: "2 when using step ids, acceptance, evidenceRefs or execution.",
    },
    explanation: {
      type: "string",
      maxLength: TASK_PLAN_LIMITS.maxExplanationChars,
      description: "Why the list or your understanding changed.",
    },
    plan: {
      type: "array",
      minItems: 1,
      maxItems: TASK_PLAN_LIMITS.maxSteps,
      description: "The complete step list, replacing any previous plan.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            minLength: 1,
            maxLength: TASK_PLAN_LIMITS.maxStepIdChars,
            description: "Short, stable handle for this milestone.",
          },
          step: {
            type: "string",
            minLength: 1,
            maxLength: TASK_PLAN_LIMITS.maxStepChars,
            description: "One verifiable milestone.",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "At most one step may be in_progress.",
          },
          acceptance: {
            type: "array",
            maxItems: TASK_PLAN_LIMITS.maxAcceptancePerStep,
            items: { type: "string", maxLength: TASK_PLAN_LIMITS.maxAcceptanceChars },
            description: "Observable results that would make this step done.",
          },
          evidenceRefs: {
            type: "array",
            maxItems: TASK_PLAN_LIMITS.maxEvidenceRefsPerStep,
            items: { type: "string", maxLength: TASK_PLAN_LIMITS.maxEvidenceRefChars },
            description: "Opaque references to results you believe show this step works.",
          },
        },
        required: ["step", "status"],
        additionalProperties: false,
      },
    },
    execution: {
      type: "object",
      description: "Current working record; a full replacement snapshot, not a log.",
      properties: {
        goal: { type: "string", maxLength: TASK_PLAN_LIMITS.maxGoalChars },
        constraints: {
          type: "array",
          maxItems: TASK_PLAN_LIMITS.maxWorkingItems,
          items: { type: "string", maxLength: TASK_PLAN_LIMITS.maxWorkingItemChars },
        },
        discoveries: {
          type: "array",
          maxItems: TASK_PLAN_LIMITS.maxWorkingItems,
          items: { type: "string", maxLength: TASK_PLAN_LIMITS.maxWorkingItemChars },
        },
        decisions: {
          type: "array",
          maxItems: TASK_PLAN_LIMITS.maxWorkingItems,
          items: { type: "string", maxLength: TASK_PLAN_LIMITS.maxWorkingItemChars },
        },
        unresolved: {
          type: "array",
          maxItems: TASK_PLAN_LIMITS.maxWorkingItems,
          items: { type: "string", maxLength: TASK_PLAN_LIMITS.maxWorkingItemChars },
        },
        nextAction: { type: "string", maxLength: TASK_PLAN_LIMITS.maxNextActionChars },
      },
      additionalProperties: false,
    },
  },
  required: ["plan"],
  additionalProperties: false,
} as const;

const resultDetailsSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    planVersion: { type: "integer", enum: [1, 2] },
    total: { type: "integer", minimum: 0 },
    completed: { type: "integer", minimum: 0 },
    inProgress: { type: "integer", minimum: 0 },
    hasExecution: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

/**
 * The v1 step shape, kept as a named type and a named validator.
 *
 * Both are compatibility surfaces: a caller that reads `{ step, status }` keeps working, and a payload
 * without `planVersion` is still validated by the same rules. Neither is a second parser — the
 * validation below delegates to the one contract.
 */
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
  const parsed = parseTaskPlanInput({ plan: value });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    steps: Object.freeze(
      parsed.plan.steps.map((step) => Object.freeze({ step: step.step, status: step.status })),
    ),
  };
}

/** Render a plan as the short text a model reads back. */
export function renderPlanSteps(steps: readonly PlanStep[]): string {
  const marks = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;
  return steps.map((step) => `${marks[step.status]} ${step.step}`).join("\n");
}

/**
 * Render the accepted plan, including the parts a checklist cannot express.
 *
 * The echo is what the model reads back on the next turn, so it names the version, keeps a stable id
 * visible, and repeats the *unresolved* items and the next action — the two fields that make a
 * long-running record usable after a context rebuild.
 */
export function renderAcceptedPlan(plan: TaskPlan): string {
  const marks = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;
  const lines = plan.steps.map((step) => {
    const id = step.id === undefined ? "" : `${step.id} `;
    const acceptance =
      step.acceptance === undefined || step.acceptance.length === 0
        ? ""
        : ` — accept: ${step.acceptance.join("; ")}`;
    return `${marks[step.status]} ${id}${step.step}${acceptance}`;
  });
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const execution = plan.execution;
  return [
    `Plan v${String(plan.planVersion)} recorded.`,
    ...(plan.explanation === undefined ? [] : [`Why: ${plan.explanation}`]),
    ...lines,
    `${String(completed)} of ${String(plan.steps.length)} steps reported completed.`,
    ...(execution?.unresolved === undefined || execution.unresolved.length === 0
      ? []
      : [`Unresolved: ${execution.unresolved.join("; ")}`]),
    ...(execution?.nextAction === undefined ? [] : [`Next action: ${execution.nextAction}`]),
  ].join("\n");
}

export function createUpdatePlanTool(): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "update_plan",
    description: "Record milestones and the current working record.",
    inputSchema,
    resultDetailsSchema,
    execute: async (input): Promise<AgentToolResult> => {
      const parsed = parseTaskPlanInput(input.args);
      if (!parsed.ok) {
        return errorResult("INVALID_PLAN", `Tool operation failed: ${parsed.reason}.`);
      }
      const plan = parsed.plan;
      const completed = plan.steps.filter((step) => step.status === "completed").length;
      const inProgress = plan.steps.filter((step) => step.status === "in_progress").length;
      return successResult(renderAcceptedPlan(plan), {
        planVersion: plan.planVersion,
        total: plan.steps.length,
        completed,
        inProgress,
        hasExecution: plan.execution !== undefined,
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

export type { TaskPlan, TaskPlanExecution, TaskPlanStep } from "../plan/task-plan-contract.js";
