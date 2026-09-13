/**
 * The AI runtime model reference.
 *
 * Semantic shape is frozen by the AI Model Invocation V2 interface freeze. Only
 * the *type ownership* moved: `@caelush/ai` cannot depend on
 * `@caelush/protocol`, so the AI runtime owns its own `ModelRef`.
 */
export interface ModelRef {
  readonly provider: string;

  readonly model: string;

  /**
   * Legacy compatibility only.
   *
   * MUST NOT participate in identity, routing or endpoint authority. The
   * provider connection owns the endpoint; two refs that differ only by
   * `baseUrl` are the same model.
   *
   * The `| undefined` is deliberate and mirrors the Protocol wire type exactly. The agent
   * kernel carries one model reference between the AI contract, the Protocol contract and
   * durable storage, and a one-optional-member shape difference would make those three
   * nominally incompatible for no semantic reason.
   */
  readonly baseUrl?: string | undefined;
}

/**
 * Model identity equality.
 *
 * Logical identity is exactly `provider + model`. `baseUrl` is deliberately
 * excluded, so a legacy endpoint hint can never split one model into two
 * catalogue entries or route a request to a different provider.
 */
export function sameModelIdentity(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}
