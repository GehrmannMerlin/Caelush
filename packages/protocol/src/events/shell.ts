import { z } from "zod";
import { ToolInvocationIdSchema } from "../primitives/ids.js";
import {
  createEventSchema,
  createVersionedEventSchema,
  OrderedTransientEventMetaSchema,
} from "./base.js";

const outputStreamSchema = z.enum(["stdout", "stderr"]);

export const ShellStartedEventSchema = createEventSchema(
  "shell.started",
  z.object({ invocationId: ToolInvocationIdSchema, command: z.string().min(1) }).strict(),
);
export const ShellOutputEventSchema = createEventSchema(
  "shell.output",
  z
    .object({ invocationId: ToolInvocationIdSchema, stream: outputStreamSchema, chunk: z.string() })
    .strict(),
);
/** Current live shell output. Historical durable output remains `ShellOutputEventSchema` v1. */
export const ShellOutputEventV2Schema = createVersionedEventSchema(
  "shell.output",
  2,
  z
    .object({ invocationId: ToolInvocationIdSchema, stream: outputStreamSchema, chunk: z.string() })
    .strict(),
  OrderedTransientEventMetaSchema,
);
export const ShellOutputTransientEventSchema = ShellOutputEventV2Schema;
export const ShellCompletedEventSchema = createEventSchema(
  "shell.completed",
  z
    .object({
      invocationId: ToolInvocationIdSchema,
      exitCode: z.number().int().optional(),
      signal: z.string().min(1).optional(),
    })
    .strict()
    .refine((value) => value.exitCode !== undefined || value.signal !== undefined, {
      message: "shell completion must include an exit code or signal",
    }),
);

export type ShellStartedEvent = z.infer<typeof ShellStartedEventSchema>;
export type ShellOutputEvent = z.infer<typeof ShellOutputEventSchema>;
export type ShellOutputEventV2 = z.infer<typeof ShellOutputEventV2Schema>;
export type ShellCompletedEvent = z.infer<typeof ShellCompletedEventSchema>;
