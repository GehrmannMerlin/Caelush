import type { JsonObject, RunId, SessionId, StepId, ObservationId } from "@caelush/protocol";
import {
  createControlHookRegistryBuilder,
  createControlHookRunner,
  ControlHookPipelineError,
  type ControlHook,
  type ControlHookContext,
  type ControlHookPipelineResult,
  type ControlHookReceipt,
  type ControlHookRegistration,
  type ControlHookRegistry,
} from "@caelush/agent";

export interface ToolFeedbackContributionInput {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceStepId: StepId;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly observationId: ObservationId;
  readonly isError: boolean;
  readonly builtInFeedback: string;
  readonly safeObservationSummary?: JsonObject;
}

export interface ToolFeedbackContribution {
  readonly id: string;
  readonly text: string;
  readonly placement: "PREPEND" | "APPEND";
}

export interface ToolFeedbackContributionHook {
  contribute(
    input: ToolFeedbackContributionInput,
    context: ControlHookContext,
  ): Promise<readonly ToolFeedbackContribution[]>;
}

export type ToolFeedbackContributionControlHook = ControlHook<
  ToolFeedbackContributionInput,
  readonly ToolFeedbackContribution[]
>;

export type ToolFeedbackContributionRegistration =
  | ControlHookRegistration<ToolFeedbackContributionHook>
  | ControlHookRegistration<ToolFeedbackContributionControlHook>;

export interface ToolFeedbackContributionBudget {
  readonly maxContributionBytes: number;
  readonly maxContributionCount: number;
}

export interface ToolFeedbackContributionPipelineResult {
  readonly content: string;
  readonly contributions: readonly ToolFeedbackContribution[];
  readonly receipts: readonly ControlHookReceipt[];
}

export interface ToolFeedbackContributionPipelineOptions {
  readonly registry?:
    | ControlHookRegistry<ToolFeedbackContributionHook>
    | ControlHookRegistry<ToolFeedbackContributionControlHook>;
  readonly registrations?: readonly ToolFeedbackContributionRegistration[];
  readonly runner?: import("@caelush/agent").ControlHookRunner;
  readonly pipelineId?: string;
  readonly clock?: { now(): import("@caelush/protocol").TimestampMs };
  readonly budget?: Partial<ToolFeedbackContributionBudget>;
  readonly textSanitizer: (text: string) => string;
}

export interface ToolFeedbackContributionPipeline {
  contribute(
    input: ToolFeedbackContributionInput,
    context: ControlHookContext,
  ): Promise<ToolFeedbackContributionPipelineResult>;
}

export const TOOL_FEEDBACK_SEPARATOR = "\n\n";
export const MAX_TOOL_FEEDBACK_CONTRIBUTION_ID_BYTES = 256;
export const MAX_TOOL_FEEDBACK_CONTRIBUTION_TEXT_BYTES = 16 * 1024;
export const MAX_TOOL_FEEDBACK_CONTRIBUTIONS_PER_HOOK = 64;
export const DEFAULT_TOOL_FEEDBACK_CONTRIBUTION_BUDGET: ToolFeedbackContributionBudget =
  Object.freeze({
    maxContributionBytes: 16 * 1024,
    maxContributionCount: 32,
  });

type CollectedHookResult = {
  readonly hookId: string;
  readonly criticality: "REQUIRED" | "OPTIONAL";
  readonly contributions: readonly ToolFeedbackContribution[];
};

export function createToolFeedbackContributionPipeline(
  options: ToolFeedbackContributionPipelineOptions,
): ToolFeedbackContributionPipeline {
  const registry =
    options.registry === undefined
      ? adaptRegistrations(options.registrations ?? [])
      : adaptRegistry(options.registry);
  const pipelineId = options.pipelineId ?? "tool-feedback-contribution";
  const runner =
    options.runner ??
    createControlHookRunner({
      pipelineId,
      clock: options.clock ?? { now: () => 0 as import("@caelush/protocol").TimestampMs },
    });
  const budget = Object.freeze({ ...DEFAULT_TOOL_FEEDBACK_CONTRIBUTION_BUDGET, ...options.budget });
  validateBudget(budget);

  return {
    async contribute(input, context) {
      const collected: CollectedHookResult[] = [];
      const execution: ControlHookPipelineResult<readonly ToolFeedbackContribution[]> =
        await runner.run(registry, input, context, {
          initial: [],
          onResult: (current, next, registration) => {
            const hookId = String(registration?.id ?? "unknown");
            const contributions = normalizeContributions(next, options.textSanitizer);
            const value = Object.freeze({
              hookId,
              criticality: registration?.criticality ?? "REQUIRED",
              contributions,
            });
            collected.push(value);
            return current;
          },
          onFailure: ({ registration }) => {
            if (registration.criticality === "OPTIONAL") {
              return { kind: "CONTINUE", result: [] } as const;
            }
            return {
              kind: "THROW",
              error: new ControlHookPipelineError("Tool Feedback pipeline failed safely."),
            } as const;
          },
        });

      const admitted = admitContributions(collected, budget);
      const prepended = admitted
        .filter((item) => item.placement === "PREPEND")
        .map((item) => item.text);
      const appended = admitted
        .filter((item) => item.placement === "APPEND")
        .map((item) => item.text);
      const content = [
        ...(prepended.length === 0 ? [] : [prepended.join(TOOL_FEEDBACK_SEPARATOR)]),
        input.builtInFeedback,
        ...(appended.length === 0 ? [] : [appended.join(TOOL_FEEDBACK_SEPARATOR)]),
      ].join(TOOL_FEEDBACK_SEPARATOR);
      return Object.freeze({
        content,
        contributions: Object.freeze(admitted),
        receipts: Object.freeze([...execution.receipts]),
      });
    },
  };
}

function adaptRegistry(
  source:
    | ControlHookRegistry<ToolFeedbackContributionHook>
    | ControlHookRegistry<ToolFeedbackContributionControlHook>,
): ControlHookRegistry<ToolFeedbackContributionControlHook> {
  const builder = createControlHookRegistryBuilder<ToolFeedbackContributionControlHook>();
  for (const registration of source.list()) {
    const hook = registration.hook as
      ToolFeedbackContributionHook | ToolFeedbackContributionControlHook;
    builder.register({
      id: registration.id,
      priority: registration.priority,
      criticality: registration.criticality,
      timeoutMs: registration.timeoutMs,
      hook: {
        invoke: (input, context) =>
          "contribute" in hook ? hook.contribute(input, context) : hook.invoke(input, context),
      },
    });
  }
  return builder.build();
}

function adaptRegistrations(
  registrations: readonly ToolFeedbackContributionRegistration[],
): ControlHookRegistry<ToolFeedbackContributionControlHook> {
  const builder = createControlHookRegistryBuilder<ToolFeedbackContributionControlHook>();
  for (const registration of registrations) {
    const hook = registration.hook as
      ToolFeedbackContributionHook | ToolFeedbackContributionControlHook;
    builder.register({
      id: registration.id,
      priority: registration.priority,
      criticality: registration.criticality,
      timeoutMs: registration.timeoutMs,
      hook: {
        invoke: (input, context) =>
          "contribute" in hook ? hook.contribute(input, context) : hook.invoke(input, context),
      },
    });
  }
  return builder.build();
}

function normalizeContributions(
  value: unknown,
  textSanitizer: (text: string) => string,
): readonly ToolFeedbackContribution[] {
  if (!Array.isArray(value) || value.length > MAX_TOOL_FEEDBACK_CONTRIBUTIONS_PER_HOOK) {
    throw new ControlHookPipelineError("Tool Feedback contribution output is invalid.");
  }
  const ids = new Set<string>();
  const normalized: ToolFeedbackContribution[] = [];
  for (const candidate of value) {
    if (!isPlainObject(candidate) || Object.keys(candidate).length !== 3) {
      throw new ControlHookPipelineError("Tool Feedback contribution output is invalid.");
    }
    if (!boundedString(candidate.id, MAX_TOOL_FEEDBACK_CONTRIBUTION_ID_BYTES)) {
      throw new ControlHookPipelineError("Tool Feedback contribution output is invalid.");
    }
    if (candidate.placement !== "PREPEND" && candidate.placement !== "APPEND") {
      throw new ControlHookPipelineError("Tool Feedback contribution output is invalid.");
    }
    if (typeof candidate.text !== "string" || candidate.text.length === 0) {
      throw new ControlHookPipelineError("Tool Feedback contribution output is invalid.");
    }
    if (ids.has(candidate.id)) {
      throw new ControlHookPipelineError("Tool Feedback contribution output is invalid.");
    }
    ids.add(candidate.id);
    const text = textSanitizer(candidate.text);
    if (!boundedString(text, MAX_TOOL_FEEDBACK_CONTRIBUTION_TEXT_BYTES)) {
      throw new ControlHookPipelineError("Tool Feedback contribution output is invalid.");
    }
    normalized.push(Object.freeze({ id: candidate.id, text, placement: candidate.placement }));
  }
  return Object.freeze(normalized);
}

function admitContributions(
  collected: readonly CollectedHookResult[],
  budget: ToolFeedbackContributionBudget,
): readonly ToolFeedbackContribution[] {
  const required = collected
    .filter((group) => group.criticality === "REQUIRED")
    .flatMap((group) => group.contributions);
  if (
    required.length > budget.maxContributionCount ||
    bytesOf(required) > budget.maxContributionBytes
  ) {
    throw new ControlHookPipelineError("Required Tool Feedback contributions exceed their budget.");
  }
  const admitted: ToolFeedbackContribution[] = [...required];
  let bytes = bytesOf(admitted);
  for (const group of collected.filter((item) => item.criticality === "OPTIONAL")) {
    for (const contribution of group.contributions) {
      const nextBytes = bytes + Buffer.byteLength(contribution.text, "utf8");
      if (admitted.length >= budget.maxContributionCount || nextBytes > budget.maxContributionBytes)
        continue;
      admitted.push(contribution);
      bytes = nextBytes;
    }
  }
  return Object.freeze(admitted);
}

function bytesOf(values: readonly ToolFeedbackContribution[]): number {
  return values.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0);
}

function validateBudget(budget: ToolFeedbackContributionBudget): void {
  if (
    !Number.isSafeInteger(budget.maxContributionBytes) ||
    budget.maxContributionBytes <= 0 ||
    !Number.isSafeInteger(budget.maxContributionCount) ||
    budget.maxContributionCount <= 0
  ) {
    throw new RangeError("Tool Feedback contribution budget must be positive safe integers.");
  }
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
