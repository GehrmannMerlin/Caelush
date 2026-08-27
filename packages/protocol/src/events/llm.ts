import { z } from "zod";
import { ModelRefSchema } from "../model.js";
import { UsageStateSchema } from "../usage.js";
import { createEventSchema } from "./base.js";

export const LlmStartedEventSchema = createEventSchema(
  "llm.started",
  z.object({ model: ModelRefSchema }).strict(),
);
export const LlmCompletedEventSchema = createEventSchema(
  "llm.completed",
  z.object({ model: ModelRefSchema, usage: UsageStateSchema }).strict(),
);

export type LlmStartedEvent = z.infer<typeof LlmStartedEventSchema>;
export type LlmCompletedEvent = z.infer<typeof LlmCompletedEventSchema>;
