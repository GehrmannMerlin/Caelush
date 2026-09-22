/**
 * The Security Tool Execution Gate contract.
 *
 * ```text
 * @caelush/agent      declares the boundary          (admission/gate-port.ts)
 * @caelush/security   implements the policy and re-exports the names
 * ```
 *
 * Phase 4F moved the declaration out of the legacy `@caelush/tools` package, which is where it lived
 * while that package was the Tool System. It is not a legacy surface: the production Security
 * implementation *is* the gate, so the shape it is asked in has to be reachable from both the package
 * that evaluates the policy and the Coding layer that translates its answer.
 *
 * ## Why the names are re-exported here
 *
 * `@caelush/security` is the package a host configures a Gate through, and it is where the type has
 * been imported from since Phase 9A. Re-exporting keeps every existing import path working while the
 * declaration lives in the one package that can host it without a build-order cycle between Security
 * and the Coding product layer. It is an export mapping, not a second declaration: there is one
 * interface, and `ToolSecurityFacts` in `@caelush/coding-agent` is structurally assignable to it.
 *
 * ## The legacy names still resolve
 *
 * `ToolExecutionGatePort`, `ToolExecutionGateInput`, `ToolExecutionGateDecision` and
 * `ToolDefinitionMetadata` keep their spellings. `ToolDefinitionMetadata` is published as an alias of
 * the canonical `ToolGateMetadata`, because that is the name the Coding admission adapter and the
 * Security composition already used and the value is the same four policy fields.
 */
export type {
  ToolExecutionGateDecision,
  ToolExecutionGateInput,
  ToolExecutionGatePort,
  ToolGateMetadata,
  ToolGateResourceAccess,
  ToolGateSecurityFacts,
  ToolGateSecretScanInput,
  ToolGateShellCommandFact,
} from "@caelush/agent";

/**
 * The Tool metadata a Gate decision is made about.
 *
 * The name is retained for every caller that has imported it since Phase 9A; the declaration is the
 * canonical one in `@caelush/agent`.
 */
export type { ToolGateMetadata as ToolDefinitionMetadata } from "@caelush/agent";

/**
 * The security-fact vocabulary a Gate may be handed, under this package's long-standing name.
 *
 * It is structural rather than a second declaration: a Coding `ToolSecurityFacts` value satisfies it,
 * and so does a fact bundle from a host with its own vocabulary.
 */
export type { ToolGateSecurityFacts as ToolSecurityFactsShape } from "@caelush/agent";
