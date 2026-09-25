import { createTimestampMs, type TimestampMs } from "@caelush/protocol";

import type {
  AgentExecutionIdentity,
  AgentTurnRef,
  LegacyContextItem,
  ContextItemPriorityClass,
} from "../loop/types.js";
import type { ContextPrepareMode } from "../loop/context/context-engine-port.js";
import {
  createControlHookId,
  createControlHookRegistryBuilder,
  type ControlHook,
  type ControlHookContext,
  type ControlHookCriticality,
  type ControlHookPipelineResult,
  type ControlHookReceipt,
  type ControlHookRegistration,
  type ControlHookRegistry,
} from "./control-hook.js";
import { createControlHookRunner, type ControlHookRunner } from "./control-hook-runner.js";

export type ContextContributionReplay = "SNAPSHOT" | "RECOMPUTE";

export interface ContextContribution {
  readonly id: string;
  readonly source: string;
  readonly items: readonly LegacyContextItem[];
  readonly replay: ContextContributionReplay;
}

export interface ContextContributionInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly mode: ContextPrepareMode;
  readonly goal: string;
}

export interface ContextContributionHook {
  contribute(
    input: ContextContributionInput,
    context: ControlHookContext,
  ): Promise<readonly ContextContribution[]>;
}

/** Generic Runner shape for a Context Contribution Hook after its named adapter. */
export type ContextContributionControlHook = ControlHook<
  ContextContributionInput,
  readonly ContextContribution[]
>;

export interface ContextContributionDiagnostic {
  readonly hookId: string;
  readonly code: ContextContributionDiagnosticCode;
  readonly message: string;
}

export type ContextContributionDiagnosticCode =
  "HOOK_FAILED" | "OUTPUT_INVALID" | "DUPLICATE_IDENTITY";

export interface ContextContributionPipelineResult {
  readonly contributions: readonly ContextContribution[];
  readonly receipts: readonly ControlHookReceipt[];
  readonly diagnostics: readonly ContextContributionDiagnostic[];
}

export interface ContextContributionPipelineLimits {
  readonly maxContributionsPerHook: number;
  readonly maxItemsPerContribution: number;
  readonly maxTotalItems: number;
  readonly maxIdentifierBytes: number;
  readonly maxItemBytes: number;
  readonly maxContributionBytes: number;
  readonly maxTotalBytes: number;
  readonly maxWhyLoadedBytes: number;
  readonly maxTokenEstimate: number;
}

export const DEFAULT_CONTEXT_CONTRIBUTION_LIMITS: ContextContributionPipelineLimits = Object.freeze(
  {
    maxContributionsPerHook: 32,
    maxItemsPerContribution: 64,
    maxTotalItems: 256,
    maxIdentifierBytes: 512,
    maxItemBytes: 16 * 1024,
    maxContributionBytes: 64 * 1024,
    maxTotalBytes: 128 * 1024,
    maxWhyLoadedBytes: 2 * 1024,
    maxTokenEstimate: 1_000_000,
  },
);

export interface ContextContributionRecomputeEligibilityInput {
  readonly hookId: string;
  readonly input: ContextContributionInput;
  readonly contribution: ContextContribution;
}

export interface ContextContributionPipelineOptions {
  readonly registry?:
    | ControlHookRegistry<ContextContributionHook>
    | ControlHookRegistry<ContextContributionControlHook>;
  readonly runner?: ControlHookRunner;
  readonly pipelineId?: string;
  readonly clock?: { now(): TimestampMs };
  readonly limits?: Partial<ContextContributionPipelineLimits>;
  readonly isRecomputeEligible?: (input: ContextContributionRecomputeEligibilityInput) => boolean;
}

export interface ContextContributionPipeline {
  readonly hasHooks: boolean;
  run(
    input: ContextContributionInput,
    context: ControlHookContext,
  ): Promise<ContextContributionPipelineResult>;
}

type ContributionHookControl = ContextContributionControlHook;

export class ContextContributionPipelineError extends Error {
  readonly code: ContextContributionDiagnosticCode;

  constructor(code: ContextContributionDiagnosticCode, message: string) {
    super(message);
    this.name = "ContextContributionPipelineError";
    this.code = code;
  }
}

export function createContextContributionPipeline(
  options: ContextContributionPipelineOptions = {},
): ContextContributionPipeline {
  const limits = resolveLimits(options.limits);
  const registry = adaptRegistry(options.registry ?? emptyRegistry());
  const runner =
    options.runner ??
    createControlHookRunner({
      pipelineId: options.pipelineId ?? "context-contribution",
      // Agent has no wall-clock authority. Production composition supplies the daemon clock;
      // this deterministic fallback keeps direct contract tests free of host time.
      clock: options.clock ?? { now: () => createTimestampMs(0) },
    });

  return {
    hasHooks: registry.list().length > 0,
    async run(input, context) {
      const diagnostics: ContextContributionDiagnostic[] = [];
      const identities = new Set<string>();
      let totalBytes = 0;
      let totalItems = 0;

      const execution: ControlHookPipelineResult<readonly ContextContribution[]> = await runner.run(
        registry,
        input,
        context,
        {
          initial: [],
          onResult: (current, next, registration) => {
            const hookId = String(registration?.id ?? "unknown");
            const normalized = validateAndNormalizeOutput({
              hookId,
              input,
              output: next,
              limits,
              identities,
              totalBytes,
              totalItems,
              ...(options.isRecomputeEligible === undefined
                ? {}
                : { isRecomputeEligible: options.isRecomputeEligible }),
            });
            totalBytes += normalized.bytes;
            totalItems += normalized.itemCount;
            return Object.freeze([...current, ...normalized.contributions]);
          },
          onFailure: ({ registration, error, current }) => {
            const hookId = String(registration.id);
            const safeError = toPipelineError(error);
            diagnostics.push(
              Object.freeze({
                hookId,
                code: safeError.code,
                message: diagnosticMessage(safeError.code),
              }),
            );
            if (registration.criticality === "OPTIONAL") {
              return { kind: "CONTINUE", result: current } as const;
            }
            return { kind: "THROW", error: safeError } as const;
          },
        },
      );

      return Object.freeze({
        contributions: Object.freeze([...execution.result]),
        receipts: Object.freeze([...execution.receipts]),
        diagnostics: Object.freeze([...diagnostics]),
      });
    },
  };
}

function emptyRegistry(): ControlHookRegistry<ContextContributionHook> {
  return createControlHookRegistryBuilder<ContextContributionHook>().build();
}

function adaptRegistry(
  source:
    | ControlHookRegistry<ContextContributionHook>
    | ControlHookRegistry<ContextContributionControlHook>,
): ControlHookRegistry<ContributionHookControl> {
  const builder = createControlHookRegistryBuilder<ContributionHookControl>();
  for (const registration of source.list()) {
    const hook = registration.hook as ContextContributionHook | ContextContributionControlHook;
    builder.register({
      id: registration.id,
      priority: registration.priority,
      criticality: registration.criticality,
      timeoutMs: registration.timeoutMs,
      hook: {
        invoke: (input, context) =>
          "invoke" in hook ? hook.invoke(input, context) : hook.contribute(input, context),
      },
    });
  }
  return builder.build();
}

function resolveLimits(
  overrides: Partial<ContextContributionPipelineLimits> | undefined,
): ContextContributionPipelineLimits {
  const limits = { ...DEFAULT_CONTEXT_CONTRIBUTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Context contribution limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function validateAndNormalizeOutput(input: {
  readonly hookId: string;
  readonly input: ContextContributionInput;
  readonly output: unknown;
  readonly limits: ContextContributionPipelineLimits;
  readonly identities: Set<string>;
  readonly totalBytes: number;
  readonly totalItems: number;
  readonly isRecomputeEligible?: (input: ContextContributionRecomputeEligibilityInput) => boolean;
}): {
  readonly contributions: readonly ContextContribution[];
  readonly bytes: number;
  readonly itemCount: number;
} {
  if (!Array.isArray(input.output) || input.output.length > input.limits.maxContributionsPerHook) {
    throw new ContextContributionPipelineError(
      "OUTPUT_INVALID",
      "Context contribution output is invalid.",
    );
  }
  const normalized: ContextContribution[] = [];
  const pendingIdentities = new Set<string>();
  let bytes = 0;
  let itemCount = 0;
  for (const candidate of input.output) {
    if (!isPlainObject(candidate)) {
      throw new ContextContributionPipelineError(
        "OUTPUT_INVALID",
        "Context contribution output is invalid.",
      );
    }
    const contribution = candidate as Record<string, unknown>;
    const id = boundedString(contribution.id, input.limits.maxIdentifierBytes);
    const source = boundedString(contribution.source, input.limits.maxIdentifierBytes);
    if (id === undefined || source === undefined) {
      throw new ContextContributionPipelineError(
        "OUTPUT_INVALID",
        "Context contribution output is invalid.",
      );
    }
    if (contribution.replay !== "SNAPSHOT" && contribution.replay !== "RECOMPUTE") {
      throw new ContextContributionPipelineError(
        "OUTPUT_INVALID",
        "Context contribution output is invalid.",
      );
    }
    if (
      !Array.isArray(contribution.items) ||
      contribution.items.length > input.limits.maxItemsPerContribution
    ) {
      throw new ContextContributionPipelineError(
        "OUTPUT_INVALID",
        "Context contribution output is invalid.",
      );
    }
    const items: LegacyContextItem[] = [];
    let contributionBytes = 0;
    for (const itemCandidate of contribution.items) {
      const item = validateItem(itemCandidate, input.limits);
      const identity = `${source}\u0000${id}\u0000${item.id}`;
      if (input.identities.has(identity) || pendingIdentities.has(identity)) {
        throw new ContextContributionPipelineError(
          "DUPLICATE_IDENTITY",
          "Context contribution identity conflicts with an existing item.",
        );
      }
      pendingIdentities.add(identity);
      contributionBytes += Buffer.byteLength(item.content, "utf8");
      items.push(Object.freeze(item));
    }
    if (contributionBytes > input.limits.maxContributionBytes) {
      throw new ContextContributionPipelineError(
        "OUTPUT_INVALID",
        "Context contribution exceeds its byte limit.",
      );
    }
    if (input.totalItems + itemCount + items.length > input.limits.maxTotalItems) {
      throw new ContextContributionPipelineError(
        "OUTPUT_INVALID",
        "Context contribution item count exceeds its limit.",
      );
    }
    const provisional: ContextContribution = {
      id,
      source,
      items: Object.freeze(items),
      replay: contribution.replay,
    };
    const replay =
      contribution.replay === "RECOMPUTE" &&
      (input.isRecomputeEligible?.({
        hookId: input.hookId,
        input: input.input,
        contribution: provisional,
      }) ??
        false)
        ? "RECOMPUTE"
        : "SNAPSHOT";
    const normalizedContribution = Object.freeze({ ...provisional, replay });
    normalized.push(normalizedContribution);
    bytes += contributionBytes;
    itemCount += items.length;
  }
  if (input.totalBytes + bytes > input.limits.maxTotalBytes) {
    throw new ContextContributionPipelineError(
      "OUTPUT_INVALID",
      "Context contribution output exceeds its byte limit.",
    );
  }
  for (const identity of pendingIdentities) input.identities.add(identity);
  return { contributions: Object.freeze(normalized), bytes, itemCount };
}

function validateItem(
  value: unknown,
  limits: ContextContributionPipelineLimits,
): LegacyContextItem {
  if (!isPlainObject(value)) {
    throw new ContextContributionPipelineError(
      "OUTPUT_INVALID",
      "Context contribution item is invalid.",
    );
  }
  const candidate = value as Record<string, unknown>;
  const id = boundedString(candidate.id, limits.maxIdentifierBytes);
  const content = typeof candidate.content === "string" ? candidate.content : undefined;
  if (
    id === undefined ||
    content === undefined ||
    Buffer.byteLength(content, "utf8") > limits.maxItemBytes
  ) {
    throw new ContextContributionPipelineError(
      "OUTPUT_INVALID",
      "Context contribution item is invalid.",
    );
  }
  const priorities: readonly ContextItemPriorityClass[] = [
    "CRITICAL",
    "HIGH",
    "NORMAL",
    "OPTIONAL",
  ];
  if (!priorities.includes(candidate.priorityClass as ContextItemPriorityClass)) {
    throw new ContextContributionPipelineError(
      "OUTPUT_INVALID",
      "Context contribution item is invalid.",
    );
  }
  const rawTokenEstimate = candidate.tokenEstimate;
  if (
    rawTokenEstimate !== undefined &&
    (typeof rawTokenEstimate !== "number" ||
      !Number.isFinite(rawTokenEstimate) ||
      rawTokenEstimate < 0 ||
      rawTokenEstimate > limits.maxTokenEstimate)
  ) {
    throw new ContextContributionPipelineError(
      "OUTPUT_INVALID",
      "Context contribution item is invalid.",
    );
  }
  const tokenEstimate = rawTokenEstimate as number | undefined;
  const whyLoaded = candidate.whyLoaded;
  if (
    whyLoaded !== undefined &&
    (typeof whyLoaded !== "string" ||
      Buffer.byteLength(whyLoaded, "utf8") > limits.maxWhyLoadedBytes)
  ) {
    throw new ContextContributionPipelineError(
      "OUTPUT_INVALID",
      "Context contribution item is invalid.",
    );
  }
  return {
    id,
    priorityClass: candidate.priorityClass as ContextItemPriorityClass,
    content,
    ...(tokenEstimate === undefined ? {} : { tokenEstimate }),
    ...(whyLoaded === undefined ? {} : { whyLoaded }),
  };
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toPipelineError(error: unknown): ContextContributionPipelineError {
  if (error instanceof ContextContributionPipelineError) return error;
  return new ContextContributionPipelineError("HOOK_FAILED", "Context contribution Hook failed.");
}

function diagnosticMessage(code: ContextContributionDiagnosticCode): string {
  switch (code) {
    case "DUPLICATE_IDENTITY":
      return "Context contribution identity conflicts with an existing item.";
    case "OUTPUT_INVALID":
      return "Context contribution output was rejected by the bounded validator.";
    case "HOOK_FAILED":
      return "Context contribution Hook failed safely.";
  }
}

export type ContextContributionRegistration =
  | ControlHookRegistration<ContextContributionHook>
  | ControlHookRegistration<ContextContributionControlHook>;
export type ContextContributionCriticality = ControlHookCriticality;
export { createControlHookId };
