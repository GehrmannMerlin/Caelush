import type { RiskLevel, ToolName } from "@caelush/protocol";

/**
 * The durable metadata an invocation must be able to state about its Tool.
 *
 * ```ts
 * export interface ToolDurableMetadata {
 *   readonly riskLevel: RiskLevel;
 * }
 * ```
 *
 * ## Why this is a migration seam and not a business model
 *
 * Protocol v1's persisted `ToolInvocation` **requires** `riskLevel`. The general `AgentTool` contract
 * deliberately does not carry one: risk is product policy, not execution contract, and a general
 * Agent host registering an in-memory Tool has no opinion about it.
 *
 * Those two facts cannot both be satisfied by putting `riskLevel` back onto `AgentTool` — that would
 * undo the Phase 4A separation and leak Coding metadata into every model-facing Tool. They can be
 * satisfied by asking the layer that *does* own risk for it, at the one moment the durable row needs
 * it, which is what this port is for.
 *
 * ```text
 * Agent Tool Layer     declares the question ("what risk does this Tool carry durably?")
 * Coding layer         answers it (CodingToolCatalog / the legacy registry projection)
 * ```
 *
 * The dependency direction is therefore `Coding layer → implements Agent durable metadata port`.
 * The Agent layer never imports the Coding layer and never learns what a capability is.
 *
 * ## Lifetime
 *
 * This contract exists because Protocol v1 persists `riskLevel` on the invocation. When a later
 * round removes that persisted field, this port loses its reason to exist and should be deleted
 * together with it — not extended with capabilities, runtime requirements or security facts, all of
 * which stay in the Coding overlay.
 */
export interface ToolDurableMetadata {
  readonly riskLevel: RiskLevel;
}

/**
 * The durable metadata lookup.
 *
 * It is a **pull**, not a snapshot: the coordinator asks for the one field the durable row needs, at
 * the moment it creates the row. A metadata source that cannot answer must fail loudly rather than
 * substitute a default, because a wrong `riskLevel` on a durable invocation is a security-relevant
 * fabrication.
 */
export interface ToolDurableMetadataPort {
  get(toolName: ToolName): Promise<ToolDurableMetadata> | ToolDurableMetadata;
}

/** Metadata a host may already hold for a Tool, in the shape the port answers with. */
export type ToolDurableMetadataInput = {
  readonly riskLevel?: RiskLevel | undefined;
};

/** Project an optional risk level onto the port's answer, refusing an absent one. */
export function requireToolDurableMetadata(
  toolName: ToolName,
  metadata: ToolDurableMetadataInput | undefined,
): ToolDurableMetadata {
  if (metadata?.riskLevel === undefined) {
    throw new ToolDurableMetadataUnavailableError(toolName);
  }
  return Object.freeze({ riskLevel: metadata.riskLevel });
}

/**
 * The durable metadata for a Tool could not be resolved.
 *
 * This is an admission-phase infrastructure failure: it is never "assume LOW", and it is never
 * "assume the Tool does not exist and skip it". Either would put a fact into durable storage that no
 * layer stated.
 */
export class ToolDurableMetadataUnavailableError extends Error {
  readonly toolName: ToolName;

  constructor(toolName: ToolName) {
    super("Durable Tool metadata is unavailable for the requested Tool.");
    this.name = "ToolDurableMetadataUnavailableError";
    this.toolName = toolName;
  }
}
