import { z } from "zod";
import { FileChangeSummarySchema } from "../file.js";
import { ToolInvocationIdSchema } from "../primitives/ids.js";
import { createEventSchema } from "./base.js";

const pathSchema = z.string().min(1);

export const FileReadEventSchema = createEventSchema(
  "file.read",
  z.object({ path: pathSchema, invocationId: ToolInvocationIdSchema.optional() }).strict(),
);
export const FileCreatedEventSchema = createEventSchema(
  "file.created",
  z
    .object({ summary: FileChangeSummarySchema, invocationId: ToolInvocationIdSchema.optional() })
    .strict(),
);
export const FileModifiedEventSchema = createEventSchema(
  "file.modified",
  z
    .object({ summary: FileChangeSummarySchema, invocationId: ToolInvocationIdSchema.optional() })
    .strict(),
);
export const FileMovedEventSchema = createEventSchema(
  "file.moved",
  z
    .object({
      fromPath: pathSchema,
      toPath: pathSchema,
      invocationId: ToolInvocationIdSchema.optional(),
      additions: z.number().int().nonnegative().optional(),
      deletions: z.number().int().nonnegative().optional(),
    })
    .strict(),
);
export const FileDeletedEventSchema = createEventSchema(
  "file.deleted",
  z
    .object({ summary: FileChangeSummarySchema, invocationId: ToolInvocationIdSchema.optional() })
    .strict(),
);

export type FileReadEvent = z.infer<typeof FileReadEventSchema>;
export type FileCreatedEvent = z.infer<typeof FileCreatedEventSchema>;
export type FileModifiedEvent = z.infer<typeof FileModifiedEventSchema>;
export type FileMovedEvent = z.infer<typeof FileMovedEventSchema>;
export type FileDeletedEvent = z.infer<typeof FileDeletedEventSchema>;
