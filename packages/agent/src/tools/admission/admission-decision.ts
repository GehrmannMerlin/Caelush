import type { ApprovalScope, JsonObject, ToolName } from "@caelush/protocol";

import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import type { ToolExecutionEnvironment } from "../types/execution-environment.js";
import type { ToolExecutionIdentity } from "../types/execution-identity.js";
import type { ToolSecurityContext } from "./security-context.js";

/**
 * What admission is asked about one Tool call.
 *
 * ```ts
 * export interface ToolAdmissionRequest {
 *   readonly identity: ToolExecutionIdentity;
 *   readonly toolName: ToolName;
 *   readonly args: Readonly<JsonObject>;
 *   readonly environment: ToolExecutionEnvironment;
 *   readonly securityContext: ToolSecurityContext;
 * }
 * ```
 *
 * Exactly five fields, and the list is closed. The general Agent admission contract describes *who*
 * is calling, *which* Tool, *with what prepared arguments*, *where*, and *under which durable Run
 * policy*. Everything else an admission implementation might want is a Coding concern and is reached
 * through the implementation's own injected dependencies:
 *
 * ```text
 * riskLevel, requiredCapabilities, runtimeRequirements   Coding security metadata
 * security facts (resource accesses, shell command, ...)  Coding Tool-specific projection
 * approval key algorithm                                 Security admission adapter
 * ```
 *
 * Putting any of those on this request would make every general Agent host describe one. `args` is
 * the **prepared, schema-validated** argument object: admission runs after preparation, so it may
 * rely on the arguments having already satisfied the Tool's declared input contract.
 */
export interface ToolAdmissionRequest {
  readonly identity: ToolExecutionIdentity;
  readonly toolName: ToolName;
  readonly args: Readonly<JsonObject>;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
}

/**
 * What a Tool is required to have approved before it may run.
 *
 * ```ts
 * export interface ToolApprovalRequirement {
 *   readonly key: string;
 *   readonly reason: string;
 *   readonly requestedScope?: ApprovalScope;
 * }
 * ```
 *
 * ## `key` is opaque to the Agent Core
 *
 * The key is the admission implementation's **internal identity** for one exact security decision. The
 * Agent Core stores it, forwards it back on recovery, and compares it for equality. That is the whole
 * of its understanding:
 *
 * ```text
 * the Agent Core never computes it
 * the Agent Core never hashes anything to derive it
 * the Agent Core never learns what a capability, a runtime requirement or a permission rule is
 * ```
 *
 * The algorithm that produces it belongs to the Security/Coding admission implementation, which is
 * the layer that knows the inputs it must be a function of.
 *
 * ## `reason` is presentation, never identity
 *
 * A reason is safe, human-readable text for an approval card. It never participates in the key, so a
 * reworded explanation cannot invalidate an existing grant and a presentation leak can never become an
 * authorization decision.
 */
export interface ToolApprovalRequirement {
  readonly key: string;
  readonly reason: string;
  readonly requestedScope?: ApprovalScope | undefined;
  /**
   * Opaque presentation the host attached to this requirement.
   *
   * The Agent Core stores it, forwards it to the host's `ToolApprovalRequestFactory` and never reads a
   * single key of it. The production admission adapter uses it to carry the gate's redacted
   * `safeAction` — a shell command preview, a structural patch preview — so the approval card keeps the
   * rich presentation the pre-4C dispatcher produced, without the `Action` vocabulary entering a
   * general Agent contract.
   *
   * A host that attaches nothing gets the factory's own bounded fallback. Nothing here participates in
   * `key`: presentation is not identity.
   */
  readonly presentation?: JsonObject | undefined;
}

/**
 * The admission verdict for one Tool call.
 *
 * ```ts
 * export type ToolPolicyDecision =
 *   | { readonly kind: "ALLOW" }
 *   | { readonly kind: "DENY"; readonly feedback: ToolFailureFeedback }
 *   | { readonly kind: "REQUIRE_APPROVAL"; readonly requirement: ToolApprovalRequirement };
 * ```
 *
 * Three arms, and no fourth:
 *
 * ```text
 * ALLOW              continue to budget admission and execution
 * DENY               do not execute; settle this as a safe, model-recoverable Tool failure
 * REQUIRE_APPROVAL   do not execute yet; either a same-Run grant already covers this exact call,
 *                    or an ApprovalRequest must be durably created and the invocation parked
 * ```
 *
 * `DENY` carries `ToolFailureFeedback` rather than a bare reason because a denial is a *Tool result*
 * the model must be able to act on: it needs a stable code, bounded safe content and a disposition.
 *
 * There is deliberately no `INFRASTRUCTURE_FAILURE` arm. An admission implementation that cannot
 * decide **throws**; the durable coordinator classifies that as a `ToolExecutionInfrastructureError`
 * with phase `ADMISSION`. Making it a value arm would invite a caller to treat "we could not decide"
 * as a decision — and the only safe reading of a broken policy evaluator is "no Tool ran".
 */
export type ToolPolicyDecision =
  | {
      readonly kind: "ALLOW";
    }
  | {
      readonly kind: "DENY";
      readonly feedback: ToolFailureFeedback;
    }
  | {
      readonly kind: "REQUIRE_APPROVAL";
      readonly requirement: ToolApprovalRequirement;
    };

/** A safe denial for a policy implementation that refuses every call. */
export function denyToolPolicyDecision(feedback: ToolFailureFeedback): ToolPolicyDecision {
  return Object.freeze({ kind: "DENY", feedback: Object.freeze(feedback) });
}
