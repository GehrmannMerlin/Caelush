import type {
  Capability,
  JsonObject,
  RiskLevel,
  ToolInvocation,
  ToolName,
} from "@caelush/protocol";

import type { ToolSecurityContext } from "./security-context.js";

/**
 * The Security policy Gate contract.
 *
 * ```text
 * @caelush/agent      declares this boundary
 * @caelush/security   implements the production policy evaluator
 * @caelush/coding-agent  translates a decision into a canonical ToolPolicyDecision
 * ```
 *
 * ## Why this is here and not in `@caelush/security`
 *
 * The gate sits between two layers that must not import each other: a Security implementation
 * evaluates policy over Coding security facts, and a Coding admission adapter translates the answer
 * into the Agent's `ToolPolicyDecision`. Declaring the contract in the layer that *consumes* it — the
 * Agent Tool framework, which already owns the canonical admission ports — is what keeps that
 * translation acyclic. `@caelush/security` re-exports these names, so no caller's import path changed
 * when Phase 4F moved the declaration out of the legacy `@caelush/tools` package.
 *
 * ## Why the facts are structural
 *
 * {@link ToolGateSecurityFacts} restates the four fact fields the policy reads rather than importing
 * the Coding facts vocabulary. Two reasons, both structural rather than stylistic:
 *
 * ```text
 * the general Agent Tool Layer must not learn what a Coding fact is
 * a tool-specific fact vocabulary must not become a build-order dependency
 * ```
 *
 * The projection is still typed where it is produced: `ToolSecurityFacts` in
 * `@caelush/coding-agent` is assignable to this shape, so a host that passes the real Coding facts gets
 * a compile-time field check and no cast. A host with its own fact model is equally welcome — the same
 * argument the Coding overlay already makes at its own projector boundary.
 */
export interface ToolGateResourceAccess {
  readonly operation: string;
  readonly path: string;
}

export interface ToolGateSecretScanInput {
  readonly kind: string;
  readonly text: string;
}

export interface ToolGateShellCommandFact {
  readonly command: string;
  readonly workdir: string;
  readonly tty: boolean;
}

export interface ToolGateSecurityFacts {
  readonly resourceAccesses: readonly ToolGateResourceAccess[];
  readonly secretScanInputs: readonly ToolGateSecretScanInput[];
  readonly shellCommand?: ToolGateShellCommandFact | undefined;
  readonly structuralPreview?: JsonObject | undefined;
  readonly opaqueInput?: boolean | undefined;
}

/**
 * The Tool metadata a Gate decision is made about.
 *
 * It is deliberately the four policy fields, not a whole Tool data description. A gate decides whether
 * a Run may do something; it does not need the model-facing schema, and handing it one would invite a
 * second authority over a value the registry already owns.
 */
export interface ToolGateMetadata {
  readonly name: ToolName;
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
  readonly runtimeRequirements: JsonObject;
}

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
  readonly definition: ToolGateMetadata;
  readonly securityContext: ToolSecurityContext;
  readonly runtimeKind?: string;
  readonly securityFacts?: ToolGateSecurityFacts;
}

/**
 * The one question the Tool execution boundary asks Security.
 *
 * A Gate answers with a decision or it throws. It never returns "unknown": an evaluator that cannot
 * reach an answer is an infrastructure failure, and the caller's job is to fail closed rather than to
 * read a missing answer as permission.
 */
export interface ToolExecutionGatePort {
  decide(input: ToolExecutionGateInput): Promise<ToolExecutionGateDecision>;
}
