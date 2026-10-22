import type {
  AgentMessageCodecRegistry,
  AgentMessageRecord,
  HistoryLookupInput,
  HistoryLookupOperations,
  SafeVisibleHistoryItem,
  TrustedHistoryScope,
  VisibleHistoryPage,
} from "@caelush/agent";
import {
  createHistorySourceRef,
  HISTORY_LOOKUP_MAX_BYTES,
  HISTORY_LOOKUP_MAX_ITEMS,
  HISTORY_SOURCE_PROJECTION_VERSION,
  parseHistorySourceRef,
} from "@caelush/agent";
import type { RunRepository } from "@caelush/storage";

import { projectPublicAssistantText } from "../services/assistant-text-projection.js";

/**
 * Resolve a `history:` reference back to the durable records it addresses.
 *
 * ```text
 * history:v1:<runId>:<firstSequence>:<lastSequence>#<identityDigest>
 * ```
 *
 * The reference is opaque to the model and carries no authority of its own. Everything that decides
 * whether it may be read is decided here, from the host's repositories:
 *
 * ```text
 * projection version   only v1 is resolvable; anything else is UNSUPPORTED_VERSION
 * identity digest      a reference whose hash does not match its own bounds is INTEGRITY_MISMATCH
 * owning Run           the range's Run must belong to the executing Session, or OUT_OF_SCOPE
 * bounds               the range must be inside that Run's own record range
 * ```
 *
 * ## What is deliberately not read
 *
 * `record.data` is never returned. Each record is decoded through the canonical codec and then
 * projected to redacted visible text, so provider-native reasoning, private replay envelopes and
 * credentials have no path out — the same projection the Transcript route uses.
 */
export interface HistoryLookupAdapterOptions {
  readonly runs: Pick<RunRepository, "get">;
  readonly messageRecords: {
    readRange(query: {
      readonly runId: string;
      readonly fromSequence: number;
      readonly toSequence: number;
      readonly limit: number;
    }): Promise<{ readonly records: readonly AgentMessageRecord[]; readonly hasMore: boolean }>;
  };
  readonly codecs: AgentMessageCodecRegistry;
}

const CURSOR_PATTERN = /^c(\d+)$/;

export function createHistoryLookupAdapter(
  options: HistoryLookupAdapterOptions,
): HistoryLookupOperations {
  return {
    async read(
      input: HistoryLookupInput,
      scope: TrustedHistoryScope,
      signal: AbortSignal,
    ): Promise<VisibleHistoryPage> {
      if (signal.aborted) throw createAbortError();
      const parsed = parseHistorySourceRef(input.sourceRef);
      if (parsed === undefined) return unavailable("UNKNOWN_SOURCE");
      if (parsed.projectionVersion !== HISTORY_SOURCE_PROJECTION_VERSION) {
        return unavailable("UNSUPPORTED_VERSION");
      }
      if (createHistorySourceRef(parsed.identity) !== input.sourceRef) {
        return unavailable("INTEGRITY_MISMATCH");
      }

      const sourceRun = await options.runs.get(parsed.identity.runId);
      if (sourceRun === null) return unavailable("SOURCE_UNAVAILABLE");
      // A reference from another Session is refused before a single record is read. The model cannot
      // widen this: the scope is bound by the Tool from its execution identity.
      if (sourceRun.sessionId !== scope.sessionId) return unavailable("OUT_OF_SCOPE");

      const fromSequence =
        input.cursor === undefined ? parsed.identity.firstSequence : parseCursor(input.cursor);
      if (fromSequence === undefined) return unavailable("CURSOR_INVALID");
      if (fromSequence < parsed.identity.firstSequence) return unavailable("CURSOR_INVALID");
      const { lastSequence } = parsed.identity;
      if (fromSequence > lastSequence) {
        return {
          kind: "PAGE",
          items: Object.freeze([]),
          sourceRef: input.sourceRef,
          integrity: "VERIFIED",
          byteCount: 0,
        };
      }

      const maxBytes = boundMaxBytes(input.maxBytes);
      const page = await options.messageRecords.readRange({
        runId: parsed.identity.runId,
        fromSequence,
        toSequence: lastSequence,
        limit: HISTORY_LOOKUP_MAX_ITEMS,
      });
      if (signal.aborted) throw createAbortError();

      const items: SafeVisibleHistoryItem[] = [];
      let byteCount = 0;
      let nextSequence: number | undefined;
      for (const record of page.records) {
        const projected = projectRecord(record, options.codecs);
        if (projected === undefined) continue;
        const bytes = Buffer.byteLength(projected.text, "utf8");
        if (items.length > 0 && byteCount + bytes > maxBytes) {
          // Resume *at* the record that did not fit rather than after it: a page that skipped a record
          // would be a page a model could not treat as a complete slice of the source.
          nextSequence = record.sequence;
          break;
        }
        items.push(
          Object.freeze({
            messageId: String(record.messageId),
            sequence: record.sequence,
            role: projected.role,
            text: projected.text,
            byteLength: bytes,
          }),
        );
        byteCount += bytes;
      }
      if (nextSequence === undefined && page.hasMore) {
        const last = page.records[page.records.length - 1];
        if (last !== undefined) nextSequence = last.sequence + 1;
      }
      return {
        kind: "PAGE",
        items: Object.freeze(items),
        ...(nextSequence === undefined || nextSequence > lastSequence
          ? {}
          : { nextCursor: `c${String(nextSequence)}` }),
        sourceRef: input.sourceRef,
        integrity: "VERIFIED",
        byteCount,
      };
    },
  };
}

function unavailable(
  reason: Extract<VisibleHistoryPage, { kind: "UNAVAILABLE" }>["reason"],
): VisibleHistoryPage {
  return { kind: "UNAVAILABLE", reason };
}

/**
 * Project one durable record to redacted visible text.
 *
 * ```text
 * read:  the canonical message the codec produces
 * never: providerState, private replay, hidden reasoning, raw data JSON
 * ```
 *
 * The canonical message is the only safe source: it is the value the model was shown. Reading
 * `record.data` directly would return whatever the codec happened to encode, including a
 * provider-native envelope on a dialect that keeps one.
 */
function projectRecord(
  record: AgentMessageRecord,
  codecs: AgentMessageCodecRegistry,
): { readonly role: SafeVisibleHistoryItem["role"]; readonly text: string } | undefined {
  let message;
  try {
    message = codecs.decode(record);
  } catch {
    return undefined;
  }
  if (message.type === "USER") {
    const text = message.content
      .map((part) => (part.type === "TEXT" ? part.text : "[attachment]"))
      .join("\n");
    return text.trim().length === 0 ? undefined : { role: "USER", text };
  }
  if (message.type === "ASSISTANT") {
    const text = message.content
      .map((part) => (part.type === "TEXT" ? part.text : `[tool ${part.toolName}]`))
      .join("\n");
    const projected = projectPublicAssistantText(text);
    return projected.trim().length === 0 ? undefined : { role: "ASSISTANT", text: projected };
  }
  if (message.type === "TOOL_RESULT") {
    const projected = projectPublicAssistantText(message.projectedContent);
    return projected.trim().length === 0 ? undefined : { role: "TOOL", text: projected };
  }
  return undefined;
}

function parseCursor(value: string): number | undefined {
  const match = CURSOR_PATTERN.exec(value);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function boundMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return 8 * 1024;
  }
  return Math.min(value, HISTORY_LOOKUP_MAX_BYTES);
}

function createAbortError(): Error {
  const error = new Error("History lookup was cancelled.");
  error.name = "AbortError";
  return error;
}
