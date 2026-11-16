import type { RunId, ToolInvocationId, WorkflowResourceBindingDraftV1 } from "@caelush/protocol";
import type { BoundedSkillResource, SkillSearchPage } from "@caelush/skills";

export interface SkillSearchOperationInput {
  readonly runId: RunId;
  readonly query: string;
  readonly cursor?: string | undefined;
  readonly pageSize: number;
  readonly signal: AbortSignal;
}

export interface SkillReadOperationInput {
  readonly runId: RunId;
  readonly invocationId: ToolInvocationId;
  readonly skillId: string;
  readonly resourcePath?: string | undefined;
  readonly cursor?: string | undefined;
  readonly signal: AbortSignal;
}

export type SkillReadOperationResult =
  | {
      readonly kind: "CORE_CONTENT_READY";
      readonly bindingDraft: WorkflowResourceBindingDraftV1;
    }
  | {
      readonly kind: "SUPPLEMENTAL_RESOURCE";
      readonly resource: BoundedSkillResource;
      readonly nextCursor?: string | undefined;
    };

export interface SkillScriptOperationInput {
  readonly runId: RunId;
  readonly bindingId: string;
  readonly resourcePath: string;
  readonly args: readonly string[];
  readonly workdir?: string | undefined;
  readonly yieldTimeMs?: number | undefined;
  readonly signal: AbortSignal;
}

/** The Phase 05 script adapter has one deliberately unavailable result. */
export interface SkillScriptOperationUnavailable {
  readonly kind: "UNAVAILABLE";
}

export interface SkillOperations {
  search(input: SkillSearchOperationInput): Promise<SkillSearchPage>;
  read(input: SkillReadOperationInput): Promise<SkillReadOperationResult>;
  runScript(input: SkillScriptOperationInput): Promise<SkillScriptOperationUnavailable>;
}

export type SkillOperationErrorCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_DISABLED"
  | "SKILL_NOT_MODEL_INVOCABLE"
  | "SKILL_CORE_INVALID"
  | "SKILL_CORE_BUDGET_EXCEEDED"
  | "SKILL_RESOURCE_DENIED"
  | "SKILL_RESOURCE_INVALID"
  | "SKILL_SEARCH_UNAVAILABLE"
  | "SCRIPT_EXECUTION_UNAVAILABLE";

const SAFE_ERROR_MESSAGES: Readonly<Record<SkillOperationErrorCode, string>> = Object.freeze({
  SKILL_NOT_FOUND: "The Skill is not available in this Run.",
  SKILL_DISABLED: "The Skill is disabled.",
  SKILL_NOT_MODEL_INVOCABLE: "The Skill is not available for automatic invocation.",
  SKILL_CORE_INVALID: "The Skill core content failed its integrity check.",
  SKILL_CORE_BUDGET_EXCEEDED: "The complete Skill core exceeds its allowed input budget.",
  SKILL_RESOURCE_DENIED: "The Skill resource is outside its bound bundle.",
  SKILL_RESOURCE_INVALID: "The Skill resource could not be read completely.",
  SKILL_SEARCH_UNAVAILABLE: "Skill search is unavailable for this Run.",
  SCRIPT_EXECUTION_UNAVAILABLE: "Skill script execution is unavailable in this phase.",
});

export class SkillOperationError extends Error {
  constructor(readonly code: SkillOperationErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "SkillOperationError";
  }
}

export const unavailableSkillScriptAdapter: SkillOperations["runScript"] = async () => ({
  kind: "UNAVAILABLE",
});
