import type {
  ApprovalRequest,
  RunId,
  ToolDefinition,
  ToolInvocation,
  ToolInvocationId,
  ToolName,
  JsonObject,
} from "@caelush/protocol";
import type { DurableToolAgentEvent, ToolDefinitionMetadata } from "./dispatcher-types.js";
import type { ToolSecurityContext } from "./security-context.js";

export type ToolExecutionGateDecision =
  | {
      readonly kind: "ALLOW";
      readonly reasonCode?: string;
      readonly safeReason?: string;
      readonly safeAction?: JsonObject;
    }
  | {
      readonly kind: "DENY";
      readonly reasonCode?: string;
      readonly safeReason?: string;
      readonly safeAction?: JsonObject;
    }
  | {
      readonly kind: "REQUIRE_APPROVAL";
      readonly reasonCode?: string;
      readonly safeReason?: string;
      readonly safeAction?: JsonObject;
    };

export interface ToolExecutionGateInput {
  readonly invocation: ToolInvocation;
  readonly toolName: ToolName;
  readonly definition: ToolDefinitionMetadata | ToolDefinition;
  readonly securityContext: ToolSecurityContext;
  readonly runtimeKind?: string;
  readonly securityFacts?: import("./security-facts.js").ToolSecurityFacts;
}

export interface ToolExecutionGatePort {
  decide(input: ToolExecutionGateInput): Promise<ToolExecutionGateDecision>;
}

export interface ToolCommittedEventNotifier {
  notifyCommitted(events: readonly DurableToolAgentEvent[]): void;
}

export interface ToolApprovalStorePort {
  getByInvocation(toolInvocationId: ToolInvocationId): Promise<ApprovalRequest | null>;
  getApprovalKeyByInvocation?(toolInvocationId: ToolInvocationId): Promise<string | null>;
  findApplicableRunGrant(input: {
    readonly runId: RunId;
    readonly approvalKey: string;
  }): Promise<ApprovalRequest | null>;
}

/**
 * The legacy approval lookup.
 *
 * Phase 4C moved the admission-time approval questions into `@caelush/agent`
 * (`ToolApprovalLookupPort`). This view keeps the legacy optional
 * `getApprovalKeyByInvocation` spelling — a Storage repository that implements it also satisfies the
 * canonical port, and one that implements the canonical `getStoredApprovalKey` spelling satisfies
 * this one. Either way there is one durable question, asked under two names until the legacy entry
 * point is retired.
 */
export interface ToolApprovalLookupPort {
  getByInvocation(toolInvocationId: ToolInvocationId): Promise<ApprovalRequest | null>;
  /** The canonical spelling of the same question. */
  getStoredApprovalKey?(toolInvocationId: ToolInvocationId): Promise<string | null | undefined>;
  /** The legacy spelling of the same question. */
  getApprovalKeyByInvocation?(toolInvocationId: ToolInvocationId): Promise<string | null>;
  findApplicableRunGrant(input: {
    readonly runId: RunId;
    readonly approvalKey: string;
  }): Promise<ApprovalRequest | null>;
}

export type ToolBudgetAdmission =
  | { readonly kind: "ALLOWED" }
  | {
      readonly kind: "EXCEEDED";
      readonly dimension: "TOOL_CALLS";
      readonly accounted: number;
      readonly limit: number;
    };

/**
 * The legacy Tool budget boundary.
 *
 * ```text
 * admit        may this one invocation run? The reservation is owned by the invocation id.
 * admitBatch   may this whole segment fit? Asked before the first handler of a batch runs.
 * start        the handler is about to run. Idempotent after an atomic RUNNING commit.
 * settle       the invocation reached a terminal state. Idempotent.
 * ```
 *
 * The canonical `ToolBudgetAdmissionPort` in `@caelush/agent` is what the admission coordinator
 * consumes. This view keeps the legacy `ALLOWED`/`EXCEEDED` answer and the whole-segment `admitBatch`
 * the legacy batch preflight still uses until 4D rewires it.
 *
 * Structural boundary; the concrete ledger adapter remains outside Tools.
 */
export interface ToolBudgetPorts {
  admit(input: {
    readonly runId: RunId;
    readonly requested: number;
    readonly invocationId?: ToolInvocationId;
  }): Promise<ToolBudgetAdmission>;
  /**
   * Optional whole-segment admission. The caller must provide only calls that
   * have already passed the adapter's non-execution preflight. Returning an
   * exceeded result prevents the dispatcher from creating any invocation or
   * starting any handler in that segment.
   */
  admitBatch?(input: {
    readonly runId: RunId;
    readonly requested: number;
  }): Promise<ToolBudgetAdmission>;
  start?(input: { readonly runId: RunId; readonly invocationId: ToolInvocationId }): Promise<void>;
  settle?(input: { readonly runId: RunId; readonly invocationId: ToolInvocationId }): Promise<void>;
}

/**
 * The legacy name for {@link ToolBudgetPorts}.
 *
 * It is an alias, not a second interface: Phase 4C made the canonical Tool budget contract
 * `@caelush/agent`'s `ToolBudgetAdmissionPort`, and this name keeps an existing import path compiling
 * while the legacy `ALLOWED`/`EXCEEDED` answer and the whole-segment `admitBatch` it still uses are
 * retired with the batch in 4D.
 */
export type ToolBudgetAdmissionPort = ToolBudgetPorts;
