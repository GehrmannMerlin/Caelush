/**
 * The Message Domain's single projection failure.
 *
 * ```text
 * UNKNOWN_MODEL_VISIBLE_MESSAGE     audience.model = true, but no projector exists
 * PROJECTION_VERSION_UNAVAILABLE    the message records no projection version
 * PROJECTION_FINGERPRINT_MISMATCH   an expected digest does not match the projection
 * INVALID_PROJECTED_CONVERSATION    the projection is not a legitimate conversation
 * ```
 *
 * The set is closed and deliberately small. Every arm is a *fail-closed* condition: none
 * of them has a recovery that produces a message anyway, because the alternative to every
 * one of them is a model shown something that was never recorded.
 *
 * ```text
 * no projector, model-visible   refusing is right; guessing a projector would put an
 *                               unversioned view into a conversation
 * no version                    refusing is right; "latest" would silently re-mean history
 * fingerprint mismatch          refusing is right; the stored receipt describes a
 *                               projection that no longer reproduces
 * invalid conversation          refusing is right; a broken Tool pairing cannot be sent
 * ```
 */
export type AgentMessageProjectionErrorCode =
  | "UNKNOWN_MODEL_VISIBLE_MESSAGE"
  | "PROJECTION_VERSION_UNAVAILABLE"
  | "PROJECTION_FINGERPRINT_MISMATCH"
  | "INVALID_PROJECTED_CONVERSATION";

/** Every projection error code, in canonical order. */
export const AGENT_MESSAGE_PROJECTION_ERROR_CODES = [
  "UNKNOWN_MODEL_VISIBLE_MESSAGE",
  "PROJECTION_VERSION_UNAVAILABLE",
  "PROJECTION_FINGERPRINT_MISMATCH",
  "INVALID_PROJECTED_CONVERSATION",
] as const satisfies readonly AgentMessageProjectionErrorCode[];

/**
 * The refusal the projection layer raises.
 *
 * It carries the closed code, the message type and — when one was involved — the
 * projection version. It never carries the message's content: a projection failure is
 * reported to a host, and a host's logs must not receive a user's text or a Tool's output
 * because a projector was missing.
 */
export class AgentMessageProjectionError extends Error {
  readonly code: AgentMessageProjectionErrorCode;
  readonly messageType: string;
  readonly projectionVersion?: number;

  constructor(
    code: AgentMessageProjectionErrorCode,
    messageType: string,
    projectionVersion?: number,
  ) {
    super(agentMessageProjectionErrorMessage(code, messageType, projectionVersion));
    this.name = "AgentMessageProjectionError";
    this.code = code;
    this.messageType = messageType;
    if (projectionVersion !== undefined) this.projectionVersion = projectionVersion;
  }
}

/** The fixed, safe summary of one projection refusal. */
export function agentMessageProjectionErrorMessage(
  code: AgentMessageProjectionErrorCode,
  messageType: string,
  projectionVersion?: number,
): string {
  const type = JSON.stringify(messageType);
  switch (code) {
    case "UNKNOWN_MODEL_VISIBLE_MESSAGE":
      return `No agent message projector is registered for model-visible type ${type}.`;
    case "PROJECTION_VERSION_UNAVAILABLE":
      return `Agent message ${type} records no model projection version.`;
    case "PROJECTION_FINGERPRINT_MISMATCH":
      return `Agent message ${type} projection fingerprint does not match the expected digest.`;
    case "INVALID_PROJECTED_CONVERSATION":
      return `Agent message ${type} projected an invalid conversation for version ${String(projectionVersion ?? "unknown")}.`;
  }
}
