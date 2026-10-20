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
  /**
   * How many distinct corrective interventions have actually reached a model request.
   *
   * ```text
   * detected   an episode crossed a threshold; nothing has been said yet
   * delivered  a model request that carried the correction was committed
   * ```
   *
   * It counts *deliveries*, never detections, which is the whole distinction the field exists for: a
   * correction that was prepared and then lost — a failed provider turn, a cancelled Run, a Context
   * build that never reached a request — must not consume the escalation step, or the model would be
   * told less and less while the same mistake repeated.
   *
   * Optional, and absent on every record written before it existed. Absence decodes as "no delivery
   * recorded", which is the conservative reading: an older episode gets its correction once.
   */
  readonly deliveredInterventions?: number;
}

/** Where a correction is in its life. */
export type ResourceCorrectionStageRecord =
  | "INPUT_CORRECTION"
  | "REVIEW_APPROACH"
  | "REBUILD_WORK_STATE";

/**
 * One corrective intervention that has been *prepared* and not yet *delivered*.
 *
 * ```text
 * detected    the repetition crossed a policy threshold
 * prepared    this record — the guidance exists, bound to the step that produced the evidence
 * delivered   a model request built from a Context that carried it settled successfully
 * ```
 *
 * The three states are distinct facts and are stored as distinct facts. Collapsing "prepared" into
 * "delivered" is what made the previous reminder both unverifiable and unrepeatable: the ledger said
 * the model had been told, the model had not been told, and nothing would ever say it again.
 *
 * It is retired by the delivery receipt, never by a timer, and it carries only bounded, already-safe
 * text — a Tool name, a schema code, declared field labels and generated guidance. No argument value,
 * no output, no exception text.
 */
export interface ResourceCorrectionRecord {
  /** Stable identity of this intervention, unique per Run. */
  readonly interventionId: string;
  readonly stage: ResourceCorrectionStageRecord;
  /** The pattern the correction is about. */
  readonly patternKey: string;
  readonly toolName: string;
  readonly code: string;
  readonly occurrences: number;
  /** The bounded guidance text a model request may carry. */
  readonly guidance: string;
  /** The durable Step whose accepted results produced the evidence. */
  readonly sourceStepId: string;
}

/** The whole window, as it is stored. */
export interface ResourceProgressRecordV1 {
  readonly version: typeof RESOURCE_PROGRESS_RECORD_VERSION;
  readonly turns: readonly ResourceProgressTurnRecord[];
  readonly active?: ResourceActivePatternRecord;
  /**
   * A correction prepared but not yet delivered.
   *
   * Optional and absent on every record written before it existed; absence means "nothing is waiting
   * to be said", which is the only safe reading of a ledger that has no opinion.
   */
  readonly correction?: ResourceCorrectionRecord;
}

/** Bounds on the stored window. Exceeding them is a policy mismatch, not a silent truncation. */
export const RESOURCE_PROGRESS_LIMITS = Object.freeze({
  maxTurns: 64,
  maxActivePatterns: 16,
  maxPatternsPerTurn: 8,
  maxSucceededToolsPerTurn: 16,
  maxFieldsPerPattern: 4,
  maxJsonBytes: 65_536,
  /** The guidance a correction may carry. It is advice, not a report; 800 characters is plenty. */
  maxCorrectionChars: 800,
  /**
   * The escalation ladder is three steps deep and then stops.
   *
   * A pattern that keeps repeating after a work-state rebuild has no more useful thing to say; the
   * episode ends when the pattern leaves the window or a call to the same Tool actually succeeds.
   * Repeating the strongest advice forever would be noise in every request, not help.
   */
  maxDeliveredInterventions: 3,
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
    deliveredInterventions: z
      .number()
      .int()
      .min(0)
      .max(RESOURCE_PROGRESS_LIMITS.maxDeliveredInterventions)
      .optional(),
  })
  .strict();

const CorrectionSchema = z
  .object({
    interventionId: z.string().min(1).max(160),
    stage: z.enum(["INPUT_CORRECTION", "REVIEW_APPROACH", "REBUILD_WORK_STATE"]),
    patternKey: z.string().regex(/^[a-f0-9]{64}$/),
    toolName: z.string().min(1).max(128),
    code: z.string().min(1).max(64),
    occurrences: z.number().int().min(0).max(RESOURCE_PROGRESS_LIMITS.maxTurns),
    guidance: z.string().min(1).max(RESOURCE_PROGRESS_LIMITS.maxCorrectionChars),
    sourceStepId: z.string().min(1).max(256),
  })
  .strict();

export const ResourceProgressRecordV1Schema = z
  .object({
    version: z.literal(RESOURCE_PROGRESS_RECORD_VERSION),
    turns: z.array(TurnSchema).max(RESOURCE_PROGRESS_LIMITS.maxTurns),
    active: ActiveSchema.optional(),
    correction: CorrectionSchema.optional(),
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
