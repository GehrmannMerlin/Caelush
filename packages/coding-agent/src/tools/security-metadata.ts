import type { JsonObject } from "@caelush/ai";
import type { Capability, RiskLevel } from "@caelush/protocol";

/**
 * The security metadata a Coding product attaches to one Tool.
 *
 * ```text
 * riskLevel              LOW | MEDIUM | HIGH | CRITICAL
 * requiredCapabilities   the capabilities the Tool needs to be authorized at all
 * runtimeRequirements    structured runtime constraints the Tool declares
 * ```
 *
 * These are the same Protocol values the durable `ToolInvocation.riskLevel` and the Security Gate
 * already consume, reused rather than restated so the first migration wave changes no wire shape
 * and no persisted row.
 *
 * They live here, and not on `AgentTool`, because they are product policy rather than execution
 * contract: a general Agent Tool has no opinion about capabilities, and the model-facing tool
 * catalog must never carry them.
 */
export interface CodingToolSecurityMetadata {
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
  readonly runtimeRequirements: JsonObject;
}

/**
 * A pure projection from validated Tool arguments to whatever a Security implementation analyzes.
 *
 * Deliberately generic in its fact type. The general Agent Tool Layer does not know what facts a
 * Coding Tool produces — resource accesses, shell commands, secret-scan inputs — and must not learn:
 * the projector is a Tool-specific function whose output type belongs to the layer that consumes it.
 *
 * The one thing it may rely on is that it is called with **prepared, schema-validated** arguments,
 * never with raw model input.
 */
export type CodingToolSecurityFactsProjector<TFacts extends JsonObject = JsonObject> = (
  args: Readonly<JsonObject>,
) => TFacts;

/**
 * A pure projection from a settled Tool execution to the effects it had.
 *
 * Effects are facts about what happened, produced only from a successful, validated result. An error
 * or uncertain outcome never fabricates one, and a projector that throws leaves the invocation
 * running rather than inventing state.
 *
 * Generic in both directions for the same reason as the facts projector: the effect vocabulary is
 * the Coding overlay's, and the first migration wave moves the contract, not the effect model.
 */
export type CodingToolEffectProjector<
  TRequest extends JsonObject = JsonObject,
  TResultDetails extends JsonObject = JsonObject,
  TEffect extends JsonObject = JsonObject,
> = (input: {
  readonly request: TRequest;
  readonly result: {
    readonly content: string;
    readonly details: TResultDetails;
    readonly isError: boolean;
  };
  readonly now: number;
}) => readonly TEffect[];
