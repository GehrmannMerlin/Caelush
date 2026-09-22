import type { ObservationId } from "@caelush/protocol";

/**
 * Where one Agent message came from.
 *
 * ```text
 * USER    a human (or a host acting as one) said it
 * MODEL   a settled model turn produced it
 * TOOL    a durable Tool observation produced it
 * AGENT   an Agent-side subsystem produced it
 * LEGACY  it was migrated from the pre-V2 durable encoding
 * ```
 *
 * The source is *provenance*, not routing. Nothing dispatches on it, and no layer may
 * treat `MODEL` as "trustworthy" or `AGENT` as "synthetic" — a message's authority over
 * the conversation comes from its `audience` and from its position in the turn, never
 * from who wrote it.
 *
 * Every arm carries the identity of the thing that produced it, so a message can always
 * be traced back without consulting a second table:
 *
 * ```text
 * USER    which kind of user input it was (a goal, a follow-up, a steering note)
 * MODEL   the LLM call id the turn settled under
 * TOOL    the ObservationId of the durable Tool observation
 * AGENT   the stable id of the producing subsystem
 * LEGACY  the pre-V2 role it was stored under
 * ```
 */
export type AgentMessageSource =
  | {
      readonly kind: "USER";

      readonly origin: "GOAL" | "FOLLOW_UP" | "STEERING";
    }
  | {
      readonly kind: "MODEL";

      readonly callId: string;
    }
  | {
      readonly kind: "TOOL";

      readonly observationId: ObservationId;
    }
  | {
      readonly kind: "AGENT";

      readonly producer: string;
    }
  | {
      readonly kind: "LEGACY";

      readonly legacyRole: "user" | "assistant" | "tool";
    };

/** Every source kind, in canonical order. */
export const AGENT_MESSAGE_SOURCE_KINDS = [
  "USER",
  "MODEL",
  "TOOL",
  "AGENT",
  "LEGACY",
] as const satisfies readonly AgentMessageSource["kind"][];

/** Every user origin, in canonical order. */
export const AGENT_USER_MESSAGE_ORIGINS = [
  "GOAL",
  "FOLLOW_UP",
  "STEERING",
] as const satisfies readonly Extract<AgentMessageSource, { kind: "USER" }>["origin"][];

/** Every pre-V2 role a migrated message may have been stored under, in canonical order. */
export const AGENT_LEGACY_ROLES = ["user", "assistant", "tool"] as const satisfies readonly Extract<
  AgentMessageSource,
  { kind: "LEGACY" }
>["legacyRole"][];

/**
 * The canonical user-input source.
 *
 * A Message Factory uses this for every user message it creates: `LEGACY` is
 * deliberately unreachable from here, because a newly created message was not migrated
 * from anything. The legacy arm exists only so Phase 5B's backfill and Phase 5F's
 * retirement can represent a row that really did come from the pre-V2 schema.
 */
export function userMessageSource(
  origin: Extract<AgentMessageSource, { kind: "USER" }>["origin"],
): AgentMessageSource {
  return Object.freeze({ kind: "USER", origin });
}

/** The canonical model-turn source. */
export function modelMessageSource(callId: string): AgentMessageSource {
  return Object.freeze({ kind: "MODEL", callId });
}

/** The canonical Tool-observation source. */
export function toolMessageSource(observationId: ObservationId): AgentMessageSource {
  return Object.freeze({ kind: "TOOL", observationId });
}

/**
 * The canonical migrated-message source.
 *
 * Exported so Phase 5B and Phase 5F have one declaration of it, and *not* used by the
 * Message Factory: a factory that could mint a legacy source would let new data claim a
 * migration history it does not have.
 */
export function legacyMessageSource(
  legacyRole: Extract<AgentMessageSource, { kind: "LEGACY" }>["legacyRole"],
): AgentMessageSource {
  return Object.freeze({ kind: "LEGACY", legacyRole });
}

/** Assert a well-formed message source. */
export function assertAgentMessageSource(value: unknown): asserts value is AgentMessageSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent message source must be an object.");
  }
  const candidate = value as { readonly kind?: unknown };

  switch (candidate.kind) {
    case "USER": {
      const origin = (candidate as { readonly origin?: unknown }).origin;
      if (!(AGENT_USER_MESSAGE_ORIGINS as readonly unknown[]).includes(origin)) {
        throw new TypeError("Agent user message source origin is unknown.");
      }
      return;
    }
    case "MODEL":
      assertNonEmpty(candidate, "callId", "Agent model message source");
      return;
    case "TOOL":
      assertNonEmpty(candidate, "observationId", "Agent tool message source");
      return;
    case "AGENT":
      assertNonEmpty(candidate, "producer", "Agent message source");
      return;
    case "LEGACY": {
      const legacyRole = (candidate as { readonly legacyRole?: unknown }).legacyRole;
      if (!(AGENT_LEGACY_ROLES as readonly unknown[]).includes(legacyRole)) {
        throw new TypeError("Agent legacy message source legacyRole is unknown.");
      }
      return;
    }
    default:
      throw new TypeError("Agent message source kind is unknown.");
  }
}

function assertNonEmpty(candidate: object, field: string, label: string): void {
  const value = (candidate as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} ${field} must be a non-empty string.`);
  }
}
