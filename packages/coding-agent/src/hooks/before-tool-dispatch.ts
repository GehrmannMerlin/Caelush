import { createHash } from "node:crypto";
import type { JsonObject, RunId, SessionId, StepId } from "@caelush/protocol";
import {
  canonicalJsonString,
  createControlHookRegistryBuilder,
  createControlHookRunner,
  ControlHookPipelineError,
  type ControlHook,
  type ControlHookContext,
  type ControlHookPipelineResult,
  type ControlHookReceipt,
  type ControlHookRegistration,
  type ControlHookRegistry,
  type ToolGateMetadata,
  type ToolGateSecurityFacts,
} from "@caelush/agent";

export type ToolGuardDecision =
  | { readonly kind: "PASS" }
  | { readonly kind: "REQUIRE_APPROVAL"; readonly code: string; readonly reason: string }
  | { readonly kind: "BLOCK"; readonly code: string; readonly reason: string };

export interface BeforeToolDispatchInput {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceStepId: StepId;
  readonly externalCallId: string;
  readonly toolName: string;
  readonly argsFingerprint: string;
  readonly safeFacts?: JsonObject;
  readonly safeAction?: JsonObject;
}

export interface BeforeToolDispatchHook {
  evaluate(input: BeforeToolDispatchInput, context: ControlHookContext): Promise<ToolGuardDecision>;
}

export type BeforeToolDispatchControlHook = ControlHook<BeforeToolDispatchInput, ToolGuardDecision>;

export type BeforeToolDispatchRegistration =
  | ControlHookRegistration<BeforeToolDispatchHook>
  | ControlHookRegistration<BeforeToolDispatchControlHook>;

export interface ToolGuardPipelineResult {
  readonly decision: ToolGuardDecision;
  readonly approvalFingerprint?: string;
  readonly receipts: readonly ControlHookReceipt[];
}

export interface ToolGuardPipeline {
  evaluate(
    input: BeforeToolDispatchInput,
    context: ControlHookContext,
  ): Promise<ToolGuardPipelineResult>;
}

export interface ToolGuardPipelineOptions {
  readonly registry?:
    | ControlHookRegistry<BeforeToolDispatchHook>
    | ControlHookRegistry<BeforeToolDispatchControlHook>;
  readonly registrations?: readonly BeforeToolDispatchRegistration[];
  readonly runner?: import("@caelush/agent").ControlHookRunner;
  readonly pipelineId?: string;
  readonly clock?: { now(): import("@caelush/protocol").TimestampMs };
  readonly sanitizeReason?: (reason: string) => string;
}

export const MAX_TOOL_GUARD_CODE_BYTES = 256;
export const MAX_TOOL_GUARD_REASON_BYTES = 2 * 1024;

const GENERIC_GUARD_REASON = "An active Tool policy requires review.";

export interface ToolGuardProjectionInput {
  readonly definition: ToolGateMetadata;
  readonly runtimeKind: string;
  readonly securityFacts?: ToolGateSecurityFacts;
}

/** Project Security facts into the deliberately small, non-sensitive Guard view. */
export function projectSafeToolGuardFacts(input: ToolGuardProjectionInput): JsonObject {
  const facts = input.securityFacts;
  const structuralKind = facts?.structuralPreview?.kind;
  const resourceOperationKinds = facts?.resourceAccesses
    .map((access) => access.operation)
    .filter((operation, index, values) => values.indexOf(operation) === index)
    .sort();
  const secretScanKinds = facts?.secretScanInputs
    .map((scan) => scan.kind)
    .filter((kind, index, values) => values.indexOf(kind) === index)
    .sort();
  return Object.freeze({
    riskLevel: input.definition.riskLevel,
    requiredCapabilities: [...input.definition.requiredCapabilities].sort(),
    runtimeKind: input.runtimeKind,
    resourceAccessCount: facts?.resourceAccesses.length ?? 0,
    resourceOperationKinds: [...(resourceOperationKinds ?? [])],
    hasShellCommand: facts?.shellCommand !== undefined,
    secretScanCount: facts?.secretScanInputs.length ?? 0,
    secretScanKinds: [...(secretScanKinds ?? [])],
    opaqueInput: facts?.opaqueInput === true,
    ...(typeof structuralKind === "string" && Buffer.byteLength(structuralKind, "utf8") <= 128
      ? { structuralKind }
      : {}),
  });
}

export function fingerprintPreparedToolArgs(args: Readonly<JsonObject>): string {
  return createHash("sha256").update(canonicalJsonString(args), "utf8").digest("hex");
}

export function createToolGuardPipeline(options: ToolGuardPipelineOptions = {}): ToolGuardPipeline {
  const registry =
    options.registry === undefined
      ? adaptRegistrations(options.registrations ?? [])
      : adaptRegistry(options.registry);
  const pipelineId = options.pipelineId ?? "tool-guard";
  const runner =
    options.runner ??
    createControlHookRunner({
      pipelineId,
      clock: options.clock ?? { now: () => 0 as import("@caelush/protocol").TimestampMs },
    });

  return {
    async evaluate(input, context) {
      const decisions: {
        hookId: string;
        decision: Exclude<ToolGuardDecision, { kind: "PASS" }>;
      }[] = [];
      const execution: ControlHookPipelineResult<ToolGuardDecision> = await runner.run(
        registry,
        input,
        context,
        {
          initial: { kind: "PASS" },
          onResult: (current, next, registration) => {
            const hookId = String(registration?.id ?? "unknown");
            const normalized = normalizeDecision(next, options.sanitizeReason);
            if (normalized.kind !== "PASS") decisions.push({ hookId, decision: normalized });
            return stricterDecision(current, normalized);
          },
          onFailure: () => ({
            kind: "THROW",
            error: new ControlHookPipelineError("Tool Guard pipeline failed safely."),
          }),
        },
      );
      return Object.freeze({
        decision: execution.result,
        ...(decisions.length === 0
          ? {}
          : { approvalFingerprint: fingerprintGuardDecisions(decisions) }),
        receipts: Object.freeze([...execution.receipts]),
      });
    },
  };
}

function adaptRegistry(
  source:
    | ControlHookRegistry<BeforeToolDispatchHook>
    | ControlHookRegistry<BeforeToolDispatchControlHook>,
): ControlHookRegistry<BeforeToolDispatchControlHook> {
  const builder = createControlHookRegistryBuilder<BeforeToolDispatchControlHook>();
  for (const registration of source.list()) {
    const hook = registration.hook as BeforeToolDispatchHook | BeforeToolDispatchControlHook;
    builder.register({
      id: registration.id,
      priority: registration.priority,
      criticality: registration.criticality,
      timeoutMs: registration.timeoutMs,
      hook: {
        invoke: (input, context) =>
          "evaluate" in hook ? hook.evaluate(input, context) : hook.invoke(input, context),
      },
    });
  }
  return builder.build();
}

function adaptRegistrations(
  registrations: readonly BeforeToolDispatchRegistration[],
): ControlHookRegistry<BeforeToolDispatchControlHook> {
  const builder = createControlHookRegistryBuilder<BeforeToolDispatchControlHook>();
  for (const registration of registrations) {
    const hook = registration.hook as BeforeToolDispatchHook | BeforeToolDispatchControlHook;
    builder.register({
      id: registration.id,
      priority: registration.priority,
      criticality: registration.criticality,
      timeoutMs: registration.timeoutMs,
      hook: {
        invoke: (input, context) =>
          "evaluate" in hook ? hook.evaluate(input, context) : hook.invoke(input, context),
      },
    });
  }
  return builder.build();
}

function normalizeDecision(
  value: unknown,
  sanitizeReason: ((reason: string) => string) | undefined,
): ToolGuardDecision {
  if (!isPlainObject(value)) throw new ControlHookPipelineError("Tool Guard output is invalid.");
  const keys = Object.keys(value);
  if (value.kind === "PASS") {
    if (keys.length !== 1) throw new ControlHookPipelineError("Tool Guard output is invalid.");
    return Object.freeze({ kind: "PASS" });
  }
  if (value.kind !== "REQUIRE_APPROVAL" && value.kind !== "BLOCK") {
    throw new ControlHookPipelineError("Tool Guard output is invalid.");
  }
  if (keys.length !== 3 || !hasBoundedString(value.code, MAX_TOOL_GUARD_CODE_BYTES)) {
    throw new ControlHookPipelineError("Tool Guard output is invalid.");
  }
  if (!hasBoundedString(value.reason, MAX_TOOL_GUARD_REASON_BYTES)) {
    throw new ControlHookPipelineError("Tool Guard output is invalid.");
  }
  let reason: string;
  try {
    reason = sanitizeReason === undefined ? value.reason : sanitizeReason(value.reason);
  } catch {
    reason = GENERIC_GUARD_REASON;
  }
  if (typeof reason !== "string" || reason.trim().length === 0) reason = GENERIC_GUARD_REASON;
  if (Buffer.byteLength(reason, "utf8") > MAX_TOOL_GUARD_REASON_BYTES) {
    reason = truncateUtf8(reason, MAX_TOOL_GUARD_REASON_BYTES);
  }
  return Object.freeze({ kind: value.kind, code: value.code, reason });
}

function stricterDecision(left: ToolGuardDecision, right: ToolGuardDecision): ToolGuardDecision {
  if (rank(right) > rank(left)) return right;
  return left;
}

function rank(decision: ToolGuardDecision): number {
  return decision.kind === "PASS" ? 0 : decision.kind === "REQUIRE_APPROVAL" ? 1 : 2;
}

function fingerprintGuardDecisions(
  decisions: readonly { hookId: string; decision: Exclude<ToolGuardDecision, { kind: "PASS" }> }[],
): string {
  return createHash("sha256")
    .update(
      canonicalJsonString(decisions.map(({ hookId, decision }) => ({ hookId, ...decision }))),
      "utf8",
    )
    .digest("hex");
}

function hasBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
