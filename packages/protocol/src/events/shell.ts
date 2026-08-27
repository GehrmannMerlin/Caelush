import { z } from "zod";
import { ToolInvocationIdSchema } from "../primitives/ids.js";
import { createEventSchema } from "./base.js";

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
export const ShellCompletedEventSchema = createEventSchema(
  "shell.completed",
  z.object({ invocationId: ToolInvocationIdSchema, exitCode: z.number().int() }).strict(),
);

export type ShellStartedEvent = z.infer<typeof ShellStartedEventSchema>;
export type ShellOutputEvent = z.infer<typeof ShellOutputEventSchema>;
export type ShellCompletedEvent = z.infer<typeof ShellCompletedEventSchema>;
