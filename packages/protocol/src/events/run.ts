import { z } from "zod";
import { AgentErrorSchema } from "../error.js";
import { JsonValueSchema } from "../primitives/json.js";
import { RunStatusSchema } from "../run.js";
import { createEventSchema } from "./base.js";

export const RunStartedEventSchema = createEventSchema(
  "run.started",
  z.object({ goal: z.string().min(1) }).strict(),
);
export const RunCompletedEventSchema = createEventSchema(
  "run.completed",
  z.object({ result: JsonValueSchema }).strict(),
);
export const RunFailedEventSchema = createEventSchema(
  "run.failed",
  z.object({ error: AgentErrorSchema }).strict(),
);
export const RunCancelledEventSchema = createEventSchema(
  "run.cancelled",
  z.object({ reason: z.string().min(1) }).strict(),
);
export const RunTimedOutEventSchema = createEventSchema(
  "run.timed_out",
  z.object({ deadlineAt: z.number().int().nonnegative() }).strict(),
);
export const StatusChangedEventSchema = createEventSchema(
  "status.changed",
  z.object({ from: RunStatusSchema, to: RunStatusSchema }).strict(),
);

export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledEventSchema>;
export type RunTimedOutEvent = z.infer<typeof RunTimedOutEventSchema>;
export type StatusChangedEvent = z.infer<typeof StatusChangedEventSchema>;
