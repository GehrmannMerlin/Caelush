import type {
  ApprovalRequest,
  JsonObject,
  RunId,
  TimestampMs,
  ToolInvocation,
} from "@caelush/protocol";

import type { PreparedToolCall } from "../call/tool-call-preparer.js";
import type { AgentBudgetBlock } from "../../loop/ports/model-request-admission.js";
import type { ToolExecutionEnvironment } from "../types/execution-environment.js";
import type { ToolExecutionIdentity } from "../types/execution-identity.js";
import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import { ToolExecutionInfrastructureError } from "../types/errors.js";
import type { ToolAdmissionRequest, ToolPolicyDecision } from "./admission-decision.js";
import type { ToolAdmissionPort, ToolAdmissionPreCheck } from "./admission-port.js";
import type { ToolApprovalLookupPort, ToolApprovalRequestFactory } from "./approval-port.js";
import { DEFAULT_TOOL_APPROVAL_SCOPE } from "./approval-port.js";
import type { ToolSecurityContext } from "./security-context.js";

/**
 * What admission decided about one Tool call.
 *
 * ```ts
 * export type ToolAdmissionOutcome =
 *   | { readonly kind: "ALLOW" }
 *   | { readonly kind: "DENY"; readonly feedback: ToolFailureFeedback }
 *   | { readonly kind: "WAITING_APPROVAL"; readonly approval: ApprovalRequest }
 *   | { readonly kind: "BUDGET_EXCEEDED"; readonly block: AgentBudgetBlock };
 * ```
 *
 * Four arms, and the list is closed:
 *
 * ```text
 * ALLOW             the coordinator may start the invocation
 * DENY              nothing ran; settle a safe model-recoverable failure
 * WAITING_APPROVAL  park the invocation with a durably created approval
 * BUDGET_EXCEEDED   nothing ran; settle a safe failure and hand the block back to the Run layer
 * ```
 *
 * There is deliberately no `EXECUTE`, no `SETTLED`, no `RETRY` and no `INFRASTRUCTURE_FAILURE` arm.
 * Admission never executes anything and never settles anything — those belong to the coordinator above
 * it. And an admission *infrastructure* failure is thrown, not returned: a caller that received it as a
 * value could file it next to a real decision, and the only safe reading of "the policy evaluator is
 * broken" is "no Tool runs, and this is not a policy outcome".
 */
export type ToolAdmissionOutcome =
  | {
      readonly kind: "ALLOW";
    }
  | {
      readonly kind: "DENY";
      readonly feedback: ToolFailureFeedback;
    }
  | {
      readonly kind: "WAITING_APPROVAL";
      readonly approval: ApprovalRequest;
      /** The opaque identity this approval was computed under, forwarded for the durable commit. */
      readonly approvalKey: string;
      /**
       * The identity the invocation's *stored* approval was created under, in recovery.
       *
       * Admission does not compare the two: the durable coordinator does, because it is deciding
       * whether to cross an execution boundary rather than whether the call is admitted.
       */
      readonly storedApprovalKey?: string | null | undefined;
    }
  | {
      readonly kind: "BUDGET_EXCEEDED";
      readonly block: AgentBudgetBlock;
    };

/** Everything the admission coordinator is built from. All injected; none of it reaches the caller. */
export interface ToolAdmissionCoordinatorOptions {
  /** The policy evaluation boundary. A broken implementation throws and is not a decision. */
  readonly policy: ToolAdmissionPort;
  /**
   * The host's bounded short-circuit, evaluated before the policy port.
   *
   * The production implementation is the legacy Tool failure memory, wrapped so that a recent failure
   * refuses the call *here*, inside the canonical flow, instead of creating a durable failure row of
   * its own.
   */
  readonly preCheck?: ToolAdmissionPreCheck | undefined;
  /**
   * The durable approval lookup.
   *
   * Absent means this host cannot express approval at all. That is not a reason to run a
   * `REQUIRE_APPROVAL` Tool: the coordinator fails closed with an `ADMISSION` infrastructure failure.
   */
  readonly approvals?: ToolApprovalLookupPort | undefined;
  /**
   * How a durable `ApprovalRequest` is built from a requirement.
   *
   * Injected so Security/Coding presentation facts — the risk level, the title, the redacted action
   * preview on the approval card — stay out of the general Agent contract.
   */
  readonly approvalRequests?: ToolApprovalRequestFactory | undefined;
  /** The Tool budget boundary. Absent means this host enforces no Tool budget. */
  readonly budget?: ToolBudgetAdmissionLike | undefined;
  readonly clock: { now(): TimestampMs };
  readonly eventIdFactory: { create(): import("@caelush/protocol").EventId };
}

/** The one method admission needs from the budget port; declared narrowly to avoid a cycle. */
export interface ToolBudgetAdmissionLike {
  admit(input: {
    readonly runId: RunId;
    readonly invocationId: import("@caelush/protocol").ToolInvocationId;
    readonly toolName: import("@caelush/protocol").ToolName;
  }): Promise<AgentBudgetBlock | null>;
}

/**
 * What admission is asked to decide, and the durable invocation it is deciding about.
 *
 * The invocation is passed in rather than reconstructed, because it is the value the caller has
 * already durably committed or loaded: reconstructing it here would make it possible for admission and
 * settlement to disagree about which row they are discussing.
 */
export interface ToolAdmissionInput {
  readonly sessionId: import("@caelush/protocol").SessionId;
  readonly invocation: ToolInvocation;
  readonly call: PreparedToolCall;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
  /**
   * The identity a stored approval for this invocation was created under, when one exists.
   *
   * `undefined` means "no stored approval to compare", which is the normal fresh-call case. A value —
   * including `null` — comes from the durable approval lookup during recovery.
   */
  readonly storedApprovalKey?: string | null | undefined;
}

/**
 * The admission coordinator.
 *
 * ```text
 * policy evaluation
 * approval grant lookup
 * approval request creation
 * approval identity handling
 * budget admission
 * ```
 *
 * ## What it never does
 *
 * ```text
 * execute a Tool
 * write Run status
 * invoke a model
 * settle a Tool result
 * schedule a batch
 * ```
 *
 * ## Ordering, and why it is fixed
 *
 * ```text
 * ① admission pre-check          a bounded host short-circuit; costs nothing
 * ② policy evaluation            DENY always wins and is never overridden by a cached grant
 * ③ approval handling            only REQUIRE_APPROVAL may consult a grant, and only for one exact key
 * ④ budget admission             the last gate; side-effecting, so it runs after every refusal
 * ```
 *
 * Policy before budget is not cosmetic. Budget admission is the only step here that *writes* — it
 * reserves a Tool-call budget entry — so a call that policy would refuse must be refused before that
 * write happens, or a denied call would consume budget.
 */
export function createToolAdmissionCoordinator(options: ToolAdmissionCoordinatorOptions) {
  return {
    async admit(input: ToolAdmissionInput): Promise<ToolAdmissionOutcome> {
      const request = toAdmissionRequest(input);
      let decision: ToolPolicyDecision;
      try {
        decision = await evaluateAdmission(options, request);
      } catch (error) {
        if (error instanceof ToolExecutionInfrastructureError) throw error;
        throw new ToolExecutionInfrastructureError(
          "ADMISSION",
          "Tool admission evaluation failed.",
          { cause: error },
        );
      }

      if (decision.kind === "DENY") {
        return Object.freeze({ kind: "DENY", feedback: decision.feedback });
      }

      if (decision.kind === "REQUIRE_APPROVAL") {
        const requirement = decision.requirement;
        const approvals = options.approvals;
        if (approvals === undefined || options.approvalRequests === undefined) {
          throw new ToolExecutionInfrastructureError(
            "ADMISSION",
            "Durable approval infrastructure is required for approval-gated Tool execution.",
          );
        }
        const grant = await approvals.findApplicableRunGrant({
          runId: input.invocation.runId,
          approvalKey: requirement.key,
        });
        // A same-Run, same-key, APPROVED, RUN-scoped grant means this exact decision was already
        // reviewed. No second ApprovalRequest is created, and admission continues to budget.
        if (grant === null) {
          const approval = await options.approvalRequests({
            identity: toIdentity(input),
            call: input.call,
            requirement,
            createdAt: options.clock.now(),
          });
          if (approval === null) {
            throw new ToolExecutionInfrastructureError(
              "ADMISSION",
              "The host could not project a durable ApprovalRequest for this Tool call.",
            );
          }
          return Object.freeze({
            kind: "WAITING_APPROVAL",
            approval,
            approvalKey: requirement.key,
            ...(input.storedApprovalKey === undefined
              ? {}
              : { storedApprovalKey: input.storedApprovalKey }),
          });
        }
      }

      const block = await admitBudget(options, input);
      if (block !== null) return Object.freeze({ kind: "BUDGET_EXCEEDED", block });
      return Object.freeze({ kind: "ALLOW" });
    },
  };
}

/** The admission coordinator contract. */
export interface ToolAdmissionCoordinator {
  admit(input: ToolAdmissionInput): Promise<ToolAdmissionOutcome>;
}

function evaluateAdmission(
  options: ToolAdmissionCoordinatorOptions,
  request: ToolAdmissionRequest,
): ToolPolicyDecision | Promise<ToolPolicyDecision> {
  const preChecked = options.preCheck?.check(request);
  if (preChecked !== undefined) return preChecked;
  try {
    return options.policy.evaluate(request);
  } catch (error) {
    // A synchronous throw from a port declared asynchronous is still an admission infrastructure
    // failure, and it must not escape as if it were a policy decision.
    throw new ToolExecutionInfrastructureError("ADMISSION", "Tool admission evaluation failed.", {
      cause: error,
    });
  }
}

async function admitBudget(
  options: ToolAdmissionCoordinatorOptions,
  input: ToolAdmissionInput,
): Promise<AgentBudgetBlock | null> {
  const budget = options.budget;
  if (budget === undefined) return null;
  try {
    return await budget.admit({
      runId: input.invocation.runId,
      invocationId: input.invocation.id,
      toolName: input.invocation.toolName,
    });
  } catch (error) {
    throw new ToolExecutionInfrastructureError("ADMISSION", "Tool budget admission failed.", {
      cause: error,
    });
  }
}

function toAdmissionRequest(input: ToolAdmissionInput): ToolAdmissionRequest {
  return Object.freeze({
    identity: toIdentity(input),
    toolName: input.invocation.toolName,
    args: input.call.args as unknown as Readonly<JsonObject>,
    environment: input.environment,
    securityContext: input.securityContext,
  });
}

function toIdentity(input: ToolAdmissionInput): ToolExecutionIdentity {
  const externalCallId = input.invocation.externalCallId;
  if (externalCallId === undefined) {
    throw new ToolExecutionInfrastructureError(
      "ADMISSION",
      "Tool admission requires a durable external call identity.",
    );
  }
  return Object.freeze({
    runId: input.invocation.runId,
    sessionId: input.sessionId,
    sourceStepId: input.invocation.stepId,
    invocationId: input.invocation.id,
    externalCallId,
  });
}

/** The scope an approval request is created under when a requirement does not state one. */
export { DEFAULT_TOOL_APPROVAL_SCOPE };
