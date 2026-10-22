import { z } from "zod";

const HISTORY_REF_MAX_LENGTH = 512;
const HISTORY_PAGE_MAX_BYTES = 32 * 1024;
const HISTORY_PAGE_MAX_ITEMS = 64;

export const HistoryLookupQuerySchema = z
  .object({
    sourceRef: z.string().min(1).max(HISTORY_REF_MAX_LENGTH),
    cursor: z
      .string()
      .regex(/^c\d+$/)
      .optional(),
    maxBytes: z.coerce.number().int().positive().max(HISTORY_PAGE_MAX_BYTES).optional(),
  })
  .strict();

const SafeVisibleHistoryItemSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    sequence: z.number().int().positive().safe(),
    role: z.enum(["USER", "ASSISTANT", "TOOL"]),
    text: z.string().max(HISTORY_PAGE_MAX_BYTES),
    byteLength: z.number().int().nonnegative().max(HISTORY_PAGE_MAX_BYTES),
  })
  .strict();

export const HistoryLookupResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("PAGE"),
      items: z.array(SafeVisibleHistoryItemSchema).max(HISTORY_PAGE_MAX_ITEMS),
      nextCursor: z
        .string()
        .regex(/^c\d+$/)
        .optional(),
      sourceRef: z.string().min(1).max(HISTORY_REF_MAX_LENGTH),
      integrity: z.literal("VERIFIED"),
      byteCount: z.number().int().nonnegative().max(HISTORY_PAGE_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("UNAVAILABLE"),
      reason: z.enum([
        "UNKNOWN_SOURCE",
        "OUT_OF_SCOPE",
        "SOURCE_UNAVAILABLE",
        "UNSUPPORTED_VERSION",
        "INTEGRITY_MISMATCH",
        "CURSOR_INVALID",
      ]),
    })
    .strict(),
]);

export type HistoryLookupQuery = z.infer<typeof HistoryLookupQuerySchema>;
export type HistoryLookupResponse = z.infer<typeof HistoryLookupResponseSchema>;
