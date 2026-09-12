import type { ReasoningLevel } from "./reasoning-level.js";

/**
 * How a requested reasoning level is reconciled with what the model offers.
 *
 * ```text
 * STRICT          the exact level or nothing
 * PREFER_BUDGET   prefer the closest level that does not exceed the request
 * ```
 *
 * `PREFER_BUDGET` is the default: it keeps a request affordable by clamping down
 * before it ever clamps up.
 */
export type ReasoningResolutionPolicy = "STRICT" | "PREFER_BUDGET";

/** Every frozen policy. */
export const REASONING_RESOLUTION_POLICIES = [
  "STRICT",
  "PREFER_BUDGET",
] as const satisfies readonly ReasoningResolutionPolicy[];

/** The policy used when a caller does not choose one. */
export const DEFAULT_REASONING_RESOLUTION_POLICY: ReasoningResolutionPolicy = "PREFER_BUDGET";

/** A caller's reasoning request, in provider-independent semantic levels. */
export interface AIReasoningRequest {
  readonly level: ReasoningLevel;
}

/**
 * How a reasoning request was settled.
 *
 * `effective` is what the adapter will be told to use; `requested` is what the
 * caller asked for. Both are observable so a caller can see a clamp instead of
 * discovering it in the bill.
 */
export interface ReasoningResolution {
  readonly requested?: ReasoningLevel;
  readonly effective?: ReasoningLevel;
  readonly mode: "NOT_REQUESTED" | "EXACT" | "CLAMPED_DOWN" | "CLAMPED_UP";
  readonly policy: ReasoningResolutionPolicy;
}

/** Every resolution mode. */
export const REASONING_RESOLUTION_MODES = [
  "NOT_REQUESTED",
  "EXACT",
  "CLAMPED_DOWN",
  "CLAMPED_UP",
] as const satisfies readonly ReasoningResolution["mode"][];

/** True when the value is one of the frozen policies. */
export function isReasoningResolutionPolicy(value: unknown): value is ReasoningResolutionPolicy {
  return (
    typeof value === "string" &&
    (REASONING_RESOLUTION_POLICIES as readonly string[]).includes(value)
  );
}
