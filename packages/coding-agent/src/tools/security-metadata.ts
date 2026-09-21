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
 *
 * ## Why `TFacts` is unconstrained
 *
 * Phase 4A declared `TFacts extends JsonObject` while no concrete projector existed. Phase 4E landed the
 * real Coding security-fact vocabulary, and it does not satisfy that constraint: `ToolSecurityFacts` is
 * an interface of named `readonly` fields, and TypeScript only considers a type assignable to
 * `JsonObject` when it has an index signature — which named-field interfaces do not have, and which
 * cannot be added without the *nested* fact types acquiring one too.
 *
 * The constraint was never what made this boundary safe. What makes it safe is that the value is opaque
 * to the general Agent layer: the projected facts are consumed only by the Security implementation, and
 * the Coding overlay statically types them against its own vocabulary — a stronger guarantee than "some
 * JSON object". JSON-safety is enforced where it actually matters, at the boundary that writes facts into
 * anything that is persisted or emitted.
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
 * ## Why `TEffect` is not constrained to `JsonObject`
 *
 * Phase 4A declared `TEffect extends JsonObject` while no concrete projector existed. Phase 4E landed
 * the real Coding effect vocabulary, and it does not satisfy that constraint: `ToolEffect` is a
 * discriminated union of `readonly` interfaces, and TypeScript does not consider an interface without
 * an index signature assignable to `JsonObject`.
 *
 * The constraint was never what made the boundary safe. What makes it safe is that the effect value is
 * opaque *to the general Agent layer*: `@caelush/agent` carries it inside a `{ kind, payload }`
 * settlement extension and never reads a field. The Coding overlay is the only consumer, and it is
 * statically typed against its own union — which is a *stronger* guarantee than "some JSON object".
 *
 * So the generic is left open, and the JSON-safety obligation is stated where it is actually enforced:
 * `codingToolEffectsPayload` writes the effects into the extension payload, which the protocol layer
 * validates.
 */
export type CodingToolEffectProjector<
  TRequest = JsonObject,
  TResultDetails extends JsonObject = JsonObject,
  TEffect = unknown,
> = (input: {
  readonly request: TRequest;
  readonly result: {
    readonly content: string;
    readonly details: TResultDetails;
    readonly isError: boolean;
  };
  readonly now: number;
}) => readonly TEffect[];
