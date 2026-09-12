import { assertExactKeys, describeValue } from "../internal/assertions.js";
import { isCapabilitySupport } from "./model-capabilities.js";
import { isCanonicalReasoningLevelList } from "../reasoning/reasoning-level.js";
import type { CapabilitySupport } from "./model-capabilities.js";
import type { ReasoningLevel } from "../reasoning/reasoning-level.js";

/**
 * Which reasoning levels one model really offers.
 *
 * `supportedLevels` must be unique and in canonical order, so a resolver can
 * compare ranks without re-sorting and two descriptors for the same model can be
 * compared for equality.
 */
export interface ModelReasoningProfile {
  readonly supportedLevels: readonly ReasoningLevel[];
  readonly defaultLevel?: ReasoningLevel;
  readonly supportsSummary: CapabilitySupport;
}

const REASONING_PROFILE_KEYS = ["supportedLevels", "defaultLevel", "supportsSummary"] as const;

/** Assert a well-formed reasoning profile. */
export function assertModelReasoningProfile(
  value: unknown,
): asserts value is ModelReasoningProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      `Model reasoning profile must be an object, received ${describeValue(value)}.`,
    );
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, REASONING_PROFILE_KEYS, "Model reasoning profile");

  if (!isCanonicalReasoningLevelList(candidate.supportedLevels)) {
    throw new TypeError(
      "Model reasoning profile supportedLevels must be unique reasoning levels in canonical order.",
    );
  }
  if (!isCapabilitySupport(candidate.supportsSummary)) {
    throw new TypeError(
      `Model reasoning profile supportsSummary must be SUPPORTED, UNSUPPORTED or UNKNOWN, received ${describeValue(candidate.supportsSummary)}.`,
    );
  }

  const defaultLevel = candidate.defaultLevel;
  if (defaultLevel === undefined) return;
  if (!(candidate.supportedLevels as readonly string[]).includes(defaultLevel as string)) {
    throw new TypeError(
      `Model reasoning profile defaultLevel ${describeValue(defaultLevel)} must be one of supportedLevels.`,
    );
  }
}
