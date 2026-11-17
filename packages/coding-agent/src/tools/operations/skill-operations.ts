import type { RunId, ToolInvocationId, WorkflowResourceBindingDraftV1 } from "@caelush/protocol";
import type {
  ToolExecutionEnvironment,
  ToolExecutionIdentity,
  ToolSecurityContext,
} from "@caelush/agent";
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
  readonly onOutput?: ((stream: "stdout" | "stderr", text: string) => void) | undefined;
}

/** The Run-bound evaluation facts a host adapter needs to revalidate script admission. */
export interface SkillScriptEvaluationContext {
  readonly identity: ToolExecutionIdentity;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext?: ToolSecurityContext | undefined;
}

/** Safe process facts projected from Runtime; host paths and executable identity never cross this port. */
export interface SkillScriptOperationExecuted {
  readonly kind: "EXECUTED";
  readonly status: "RUNNING" | "EXITED";
  readonly sessionId?: string | undefined;
  readonly output: string;
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
  readonly totalOutputBytes: number;
  readonly omittedBytes: number;
  readonly durationMs?: number | undefined;
}

/** An explicit result for hosts that do not have the verified script boundary. */
export interface SkillScriptOperationUnavailable {
  readonly kind: "UNAVAILABLE";
}

export type SkillScriptOperationResult =
  SkillScriptOperationExecuted | SkillScriptOperationUnavailable;

export interface SkillOperations {
  search(input: SkillSearchOperationInput): Promise<SkillSearchPage>;
  read(input: SkillReadOperationInput): Promise<SkillReadOperationResult>;
  runScript(
    input: SkillScriptOperationInput,
    evaluationContext: SkillScriptEvaluationContext,
  ): Promise<SkillScriptOperationResult>;
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
  | "SKILL_BINDING_INACTIVE"
  | "SKILL_WORKSPACE_MISMATCH"
  | "SKILL_PREPARATION_REQUIRED"
  | "SKILL_SCRIPT_DENIED"
  | "SKILL_SCRIPT_INTERPRETER_UNAVAILABLE"
  | "SKILL_SCRIPT_UNAVAILABLE"
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
  SKILL_BINDING_INACTIVE: "The Skill binding is not active in this Run.",
  SKILL_WORKSPACE_MISMATCH: "The Skill binding does not belong to this workspace.",
  SKILL_PREPARATION_REQUIRED: "The Skill content must be prepared in Context before execution.",
  SKILL_SCRIPT_DENIED: "The requested Skill script or working directory is not allowed.",
  SKILL_SCRIPT_INTERPRETER_UNAVAILABLE: "The Skill script interpreter is unavailable.",
  SKILL_SCRIPT_UNAVAILABLE: "The verified Skill script execution boundary is unavailable.",
  SCRIPT_EXECUTION_UNAVAILABLE: "Skill script execution is unavailable in this environment.",
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
