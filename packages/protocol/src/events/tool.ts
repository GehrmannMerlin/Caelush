import { z } from "zod";
import { AgentErrorSchema } from "../error.js";
import { ObservationIdSchema, ToolInvocationIdSchema } from "../primitives/ids.js";
import { ToolNameSchema } from "../tool.js";
import { RiskLevelSchema } from "../policy.js";
import { createEventSchema } from "./base.js";

const outputStreamSchema = z.enum(["stdout", "stderr"]);

export const ToolRequestedEventSchema = createEventSchema(
  "tool.requested",
  z
    .object({
      invocationId: ToolInvocationIdSchema,
      toolName: ToolNameSchema,
      externalCallId: z.string().min(1).optional(),
      riskLevel: RiskLevelSchema,
    })
    .strict(),
);
export const ToolStartedEventSchema = createEventSchema(
  "tool.started",
  z.object({ invocationId: ToolInvocationIdSchema }).strict(),
);
export const ToolOutputEventSchema = createEventSchema(
  "tool.output",
  z
    .object({ invocationId: ToolInvocationIdSchema, stream: outputStreamSchema, chunk: z.string() })
    .strict(),
);
export const ToolCompletedEventSchema = createEventSchema(
  "tool.completed",
  z.object({ invocationId: ToolInvocationIdSchema, observationId: ObservationIdSchema }).strict(),
);
export const ToolFailedEventSchema = createEventSchema(
  "tool.failed",
  z.object({ invocationId: ToolInvocationIdSchema, error: AgentErrorSchema }).strict(),
);

export type ToolRequestedEvent = z.infer<typeof ToolRequestedEventSchema>;
export type ToolStartedEvent = z.infer<typeof ToolStartedEventSchema>;
export type ToolOutputEvent = z.infer<typeof ToolOutputEventSchema>;
export type ToolCompletedEvent = z.infer<typeof ToolCompletedEventSchema>;
export type ToolFailedEvent = z.infer<typeof ToolFailedEventSchema>;
