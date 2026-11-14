import {
  SkillCapabilityResponseSchema,
  type SkillCapabilityResponse,
  type SkillFailureReason,
} from "@caelush/protocol";

export interface SkillFeatureReadiness {
  readonly enabled: boolean;
  readonly catalogReady: boolean;
  readonly invocationReady: boolean;
  readonly scriptExecutionReady: boolean;
  readonly presentationReady: boolean;
}

export type SkillFeatureName = "catalog" | "invocation" | "scriptExecution";

export const SKILL_FEATURE_ENVIRONMENT_KEY = "CAELUSH_FEATURE_SKILLS_V1";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

export const DEFAULT_SKILL_FEATURE_READINESS: SkillFeatureReadiness = Object.freeze({
  enabled: false,
  catalogReady: false,
  invocationReady: false,
  scriptExecutionReady: false,
  presentationReady: false,
});

/** Skill V1 remains OFF unless a host explicitly enables its master switch. */
export function resolveSkillFeatureEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment[SKILL_FEATURE_ENVIRONMENT_KEY]?.trim().toLowerCase();
  return value !== undefined && ENABLED_VALUES.has(value);
}

const SAFE_MESSAGES: Readonly<Record<SkillFailureReason, string>> = {
  SKILLS_UNAVAILABLE: "Skill features are unavailable.",
  SKILL_NOT_FOUND: "The requested Skill was not found.",
  SKILL_SELECTION_STALE: "The Skill selection has changed.",
  SKILL_DISABLED: "The requested Skill is disabled.",
  SKILL_LOAD_FAILED: "The Skill could not be loaded.",
  SKILL_CORE_BUDGET_EXCEEDED: "The Skill exceeds the available context budget.",
  SKILL_ARTIFACT_INVALID: "The Skill artifact is invalid.",
  SKILL_RESOURCE_DENIED: "The Skill resource is not available.",
  SKILL_SCRIPT_UNAVAILABLE: "Skill scripts are unavailable.",
};

export class SkillServiceError extends Error {
  readonly reason: SkillFailureReason;

  constructor(reason: SkillFailureReason) {
    super(SAFE_MESSAGES[reason]);
    this.name = "SkillServiceError";
    this.reason = reason;
  }
}

export function createSkillCapabilityResponse(
  readiness: SkillFeatureReadiness = DEFAULT_SKILL_FEATURE_READINESS,
): SkillCapabilityResponse {
  const enabled = readiness.enabled;
  const catalog = enabled && readiness.catalogReady;
  const invocation = catalog && readiness.invocationReady;
  const scriptExecution = invocation && readiness.scriptExecutionReady;

  return SkillCapabilityResponseSchema.parse({
    schemaVersion: 1,
    enabled,
    catalog,
    invocation,
    scriptExecution,
    presentationVersion: enabled && readiness.presentationReady ? 4 : null,
  });
}

export function assertSkillCapabilityAvailable(
  capabilities: SkillCapabilityResponse,
  feature: SkillFeatureName,
): void {
  if (!capabilities.enabled || !capabilities[feature]) {
    throw new SkillServiceError("SKILLS_UNAVAILABLE");
  }
}
