import { assertExactKeys, describeValue } from "../internal/assertions.js";

/**
 * Three-state capability support.
 *
 * ```text
 * SUPPORTED     explicitly supported
 * UNSUPPORTED   explicitly not supported; preflight rejects
 * UNKNOWN       unknown; the frozen strategy may still attempt it
 * ```
 *
 * `UNKNOWN` must never be collapsed into either of the other two states: it is
 * what lets a newly discovered model be tried without claiming a guarantee.
 */
export type CapabilitySupport = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

/** Every frozen capability support state. */
export const CAPABILITY_SUPPORT_STATES = [
  "SUPPORTED",
  "UNSUPPORTED",
  "UNKNOWN",
] as const satisfies readonly CapabilitySupport[];

/** The model capabilities the AI core reasons about. */
export interface ModelCapabilities {
  readonly streaming: CapabilitySupport;
  readonly toolCalling: CapabilitySupport;
  readonly parallelToolCalls: CapabilitySupport;
  readonly structuredOutput: CapabilitySupport;
  readonly vision: CapabilitySupport;
  readonly reasoning: CapabilitySupport;
  readonly reasoningSummary: CapabilitySupport;
  readonly promptCaching: CapabilitySupport;
  readonly usageReporting: CapabilitySupport;
}

/** Every capability field, in canonical order. */
export const MODEL_CAPABILITY_FIELDS = [
  "streaming",
  "toolCalling",
  "parallelToolCalls",
  "structuredOutput",
  "vision",
  "reasoning",
  "reasoningSummary",
  "promptCaching",
  "usageReporting",
] as const satisfies readonly (keyof ModelCapabilities)[];

/** True when the value is one of the frozen support states. */
export function isCapabilitySupport(value: unknown): value is CapabilitySupport {
  return (
    typeof value === "string" && (CAPABILITY_SUPPORT_STATES as readonly string[]).includes(value)
  );
}

/** Assert a complete capability record. Every field is mandatory. */
export function assertModelCapabilities(value: unknown): asserts value is ModelCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Model capabilities must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, MODEL_CAPABILITY_FIELDS, "Model capabilities");

  for (const field of MODEL_CAPABILITY_FIELDS) {
    if (!isCapabilitySupport(candidate[field])) {
      throw new TypeError(
        `Model capabilities ${field} must be SUPPORTED, UNSUPPORTED or UNKNOWN, received ${describeValue(candidate[field])}.`,
      );
    }
  }
}

/** True when a capability is explicitly unsupported. */
export function isUnsupported(capability: CapabilitySupport): boolean {
  return capability === "UNSUPPORTED";
}

/** True when a capability is explicitly supported. */
export function isSupported(capability: CapabilitySupport): boolean {
  return capability === "SUPPORTED";
}

/** True when a capability may be attempted: supported or unknown. */
export function isAttemptable(capability: CapabilitySupport): boolean {
  return capability !== "UNSUPPORTED";
}
