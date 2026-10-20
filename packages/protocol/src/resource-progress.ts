import { z } from "zod";

/**
 * The durable shape of the repeated-failure window.
 *
 * ```text
 * private persistence contract - never part of an HTTP Run projection
 * ```
 *
 * It lives in `@caelush/protocol` because two packages must agree on its bytes: Core derives it and
 * Storage persists it. Neither may own the other's runtime types, and a JSON-safe record is the one
 * thing both can share without an import in either direction.
 *
 * ## What this is not
 *
 * It is not a second execution ledger. Every field is a projection of accepted `TOOL_RESULT`
 * facts, so the same accepted batches always produce the same value, and losing it costs only the
 * evidence gathered so far - never a Tool result, an invocation or a Run transition.
 */

export const RESOURCE_PROGRESS_RECORD_VERSION = 1 as const;

/** One declared field problem, reduced to a label a reminder may quote. */
export interface ResourceProgressFieldRecord {
  readonly keyword: string;
  readonly name?: string;
}

/** One repeated failure pattern inside the window. */
export interface ResourceProgressPatternRecord {
  /** Stable identity: Tool, code, declared field signature and classifier version. */
  readonly key: string;
  readonly toolName: string;
  readonly code: string;
  readonly fields: readonly ResourceProgressFieldRecord[];
}

/** One accepted Tool batch, reduced to what the window needs. */
export interface ResourceProgressTurnRecord {
  /** The batch's durable identity (its source Step), used as the idempotency cursor. */
  readonly turnId: string;
  readonly patterns: readonly ResourceProgressPatternRecord[];
  readonly succeededTools: readonly string[];
  readonly classified: boolean;
}

/** The active repeated-failure episode. */
export interface ResourceActivePatternRecord {
  readonly key: string;
  readonly toolName: string;
  readonly code: string;
  /** The turn the current episode starts after; occurrences are counted from here. */
  readonly sinceTurnId?: string;
  readonly replans: number;
  readonly nudged: boolean;
}

/** The whole window, as it is stored. */
export interface ResourceProgressRecordV1 {
  readonly version: typeof RESOURCE_PROGRESS_RECORD_VERSION;
  readonly turns: readonly ResourceProgressTurnRecord[];
  readonly active?: ResourceActivePatternRecord;
}

/** Bounds on the stored window. Exceeding them is a policy mismatch, not a silent truncation. */
export const RESOURCE_PROGRESS_LIMITS = Object.freeze({
  maxTurns: 64,
  maxActivePatterns: 16,
  maxPatternsPerTurn: 8,
  maxSucceededToolsPerTurn: 16,
  maxFieldsPerPattern: 4,
  maxJsonBytes: 65_536,
});

const FieldSchema = z
  .object({
    keyword: z.string().min(1).max(32),
    name: z.string().min(1).max(64).optional(),
  })
  .strict();

const PatternSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    toolName: z.string().min(1).max(128),
    code: z.string().min(1).max(64),
    fields: z.array(FieldSchema).max(RESOURCE_PROGRESS_LIMITS.maxFieldsPerPattern),
  })
  .strict();

const TurnSchema = z
  .object({
    turnId: z.string().min(1).max(256),
    patterns: z.array(PatternSchema).max(RESOURCE_PROGRESS_LIMITS.maxPatternsPerTurn),
    succeededTools: z
      .array(z.string().min(1).max(128))
      .max(RESOURCE_PROGRESS_LIMITS.maxSucceededToolsPerTurn),
    classified: z.boolean(),
  })
  .strict();

const ActiveSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    toolName: z.string().min(1).max(128),
    code: z.string().min(1).max(64),
    sinceTurnId: z.string().min(1).max(256).optional(),
    replans: z.number().int().min(0).max(RESOURCE_PROGRESS_LIMITS.maxTurns),
    nudged: z.boolean(),
  })
  .strict();

export const ResourceProgressRecordV1Schema = z
  .object({
    version: z.literal(RESOURCE_PROGRESS_RECORD_VERSION),
    turns: z.array(TurnSchema).max(RESOURCE_PROGRESS_LIMITS.maxTurns),
    active: ActiveSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > RESOURCE_PROGRESS_LIMITS.maxJsonBytes) {
      context.addIssue({
        code: "custom",
        message: "resource progress window exceeds its byte limit",
      });
    }
    const ids = record.turns.map((turn) => turn.turnId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "resource progress turn identities are not unique",
      });
    }
    const activeCount = record.turns.reduce((total, turn) => total + turn.patterns.length, 0);
    if (
      activeCount >
      RESOURCE_PROGRESS_LIMITS.maxTurns * RESOURCE_PROGRESS_LIMITS.maxPatternsPerTurn
    ) {
      context.addIssue({ code: "custom", message: "resource progress window is too wide" });
    }
  });

/** Parse a stored window, refusing anything this version does not define. */
export function parseResourceProgressRecordV1(value: unknown): ResourceProgressRecordV1 {
  return ResourceProgressRecordV1Schema.parse(value) as ResourceProgressRecordV1;
}
