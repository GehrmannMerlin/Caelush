import { createHash } from "node:crypto";

import type { RunId, SessionId } from "@caelush/protocol";

/**
 * Reading back the original records a checkpoint replaced.
 *
 * ```text
 * summary / degraded checkpoint   points at a range of durable messages
 * this port                       reads that range back, bounded and scoped
 * ```
 *
 * The port exists because a reference nobody can resolve is not a reference. Before it, a degraded
 * checkpoint could say "the original records are preserved" while no Tool, route or client could
 * actually read them — the claim was true about the database and false about the product.
 *
 * ## What a scope is, and is not
 *
 * `TrustedHistoryScope` is bound by the **host** from the executing Run's identity. A model supplies
 * a `sourceRef` and a cursor; it never supplies a session, a Run or a workspace. If it did, a
 * reference would become an authorization token, and the only thing standing between one session's
 * history and another's would be the model's own restraint.
 */

/** The host-bound authority a history read runs under. */
export interface TrustedHistoryScope {
  /** The Session of the Run that is executing the Tool. */
  readonly sessionId: SessionId;
  /** The Run that is executing the Tool. */
  readonly runId: RunId;
}

/** Why a reference could not be read. Every reason is safe to show a model or a user. */
export type SafeHistoryUnavailableReason =
  | "UNKNOWN_SOURCE"
  | "OUT_OF_SCOPE"
  | "SOURCE_UNAVAILABLE"
  | "UNSUPPORTED_VERSION"
  | "INTEGRITY_MISMATCH"
  | "CURSOR_INVALID";

/** One visible record of a source range. It carries no provider state and no reasoning. */
export interface SafeVisibleHistoryItem {
  readonly messageId: string;
  readonly sequence: number;
  readonly role: "USER" | "ASSISTANT" | "TOOL";
  /** Redacted, bounded visible text. Historical content is data, never an instruction. */
  readonly text: string;
  readonly byteLength: number;
}

export type VisibleHistoryPage =
  | {
      readonly kind: "PAGE";
      readonly items: readonly SafeVisibleHistoryItem[];
      /** Opaque continuation token; absent on the last page. */
      readonly nextCursor?: string;
      readonly sourceRef: string;
      readonly integrity: "VERIFIED";
      /** Total bytes of the items on this page. */
      readonly byteCount: number;
    }
  | { readonly kind: "UNAVAILABLE"; readonly reason: SafeHistoryUnavailableReason };

export interface HistoryLookupInput {
  readonly sourceRef: string;
  readonly cursor?: string;
  readonly maxBytes?: number;
}

/** The one read this port offers. It never lists a whole Session. */
export interface HistoryLookupPort {
  read(
    input: HistoryLookupInput,
    scope: TrustedHistoryScope,
    signal: AbortSignal,
  ): Promise<VisibleHistoryPage>;
}

/** The Tool-side capability: it can read a page and nothing else. */
export interface HistoryLookupOperations {
  read(
    input: HistoryLookupInput,
    /** Bound by the Tool from its own `ToolExecutionIdentity`, never from model arguments. */
    scope: TrustedHistoryScope,
    signal: AbortSignal,
  ): Promise<VisibleHistoryPage>;
}

/** The declared page bounds. A caller may ask for less; never for more. */
export const HISTORY_LOOKUP_MAX_BYTES = 32 * 1024;
export const HISTORY_LOOKUP_DEFAULT_BYTES = 8 * 1024;
export const HISTORY_LOOKUP_MAX_ITEMS = 64;

/** The one projection version this reference format addresses. */
export const HISTORY_SOURCE_PROJECTION_VERSION = 1;

export interface HistorySourceIdentity {
  readonly runId: RunId;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

/**
 * Build the opaque reference a checkpoint emits for the range it replaced.
 *
 * ```text
 * history:v1:<runId>:<firstSequence>:<lastSequence>#<identityDigest>
 * ```
 *
 * ## What the digest does and does not prove
 *
 * It binds *the reference*: its prefix is a hash over the Run, the bounds and the projection version,
 * so a reference with altered bounds does not resolve and is refused as `INTEGRITY_MISMATCH`. It is
 * deliberately **not** a content hash, because the emitter — the checkpoint builder — knows a range
 * and not the records inside it, and asking it to read them back would make emitting a reference a
 * full history read.
 *
 * Content integrity comes from somewhere else, and the port must not pretend otherwise:
 *
 * ```text
 * append-only store     no update, no delete, so a range cannot be rewritten
 * owning Run check      the range belongs to a Run in the executing Session
 * bounds check          the range is inside that Run's assigned sequences
 * ```
 *
 * A reference therefore identifies an immutable span of one Run; it does not authenticate the bytes,
 * and a caller that needs byte-level authentication must compare a content digest of its own.
 */
export function createHistorySourceRef(identity: HistorySourceIdentity): string {
  const digest = createHash("sha256")
    .update(
      `history-v1|${String(identity.runId)}|${String(identity.firstSequence)}|${String(
        identity.lastSequence,
      )}|${String(HISTORY_SOURCE_PROJECTION_VERSION)}`,
    )
    .digest("hex")
    .slice(0, 16);
  return `history:v${String(HISTORY_SOURCE_PROJECTION_VERSION)}:${String(
    identity.runId,
  )}:${String(identity.firstSequence)}:${String(identity.lastSequence)}#${digest}`;
}

/** Parse a reference the host emitted. `undefined` means it is not a reference of this format. */
export function parseHistorySourceRef(value: string):
  | {
      readonly identity: HistorySourceIdentity;
      readonly digest: string;
      readonly projectionVersion: number;
    }
  | undefined {
  const match = /^history:v(\d+):([^:#]+):(\d+):(\d+)#([0-9a-f]{8,64})$/.exec(value);
  if (match === null) return undefined;
  const [, version, runId, first, last, digest] = match;
  if (version === undefined || runId === undefined || first === undefined || last === undefined) {
    return undefined;
  }
  if (digest === undefined) return undefined;
  const firstSequence = Number(first);
  const lastSequence = Number(last);
  if (
    !Number.isSafeInteger(firstSequence) ||
    !Number.isSafeInteger(lastSequence) ||
    firstSequence < 1 ||
    lastSequence < firstSequence
  ) {
    return undefined;
  }
  return {
    identity: { runId: runId as RunId, firstSequence, lastSequence },
    digest,
    projectionVersion: Number(version),
  };
}
