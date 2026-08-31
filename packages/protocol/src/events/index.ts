import { z } from "zod";
import {
  DurableEventSchema,
  EphemeralEventSchema,
  EventDurabilitySchema,
  EventVisibilitySchema,
} from "./base.js";
import {
  RunCancelledEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunStartedEventSchema,
  RunTimedOutEventSchema,
  StatusChangedEventSchema,
} from "./run.js";
import { PlanUpdatedEventSchema, ReasoningSummaryEventSchema } from "./reasoning.js";
import {
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  ToolOutputEventSchema,
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
} from "./tool.js";
import {
  FileCreatedEventSchema,
  FileDeletedEventSchema,
  FileModifiedEventSchema,
  FileMovedEventSchema,
  FileReadEventSchema,
} from "./file.js";
import {
  ShellCompletedEventSchema,
  ShellOutputEventSchema,
  ShellStartedEventSchema,
} from "./shell.js";
import {
  ProcessOutputEventSchema,
  ProcessStartedEventSchema,
  ProcessStoppedEventSchema,
} from "./process.js";
import {
  VerificationCompletedEventSchema,
  VerificationStartedEventSchema,
} from "./verification.js";
import { ApprovalRequestedEventSchema, ApprovalResolvedEventSchema } from "./approval.js";
import {
  LlmCompletedEventSchema,
  LlmFailedEventSchema,
  LlmStartedEventSchema,
  RetryScheduledEventSchema,
  RetryStartedEventSchema,
} from "./llm.js";
import { ErrorEventSchema } from "./error.js";
import { BudgetExceededEventSchema } from "./budget.js";

export { DurableEventSchema, EphemeralEventSchema, EventDurabilitySchema, EventVisibilitySchema };
export type { DurableEvent, EphemeralEvent, EventDurability, EventVisibility } from "./base.js";
export { BudgetExceededEventSchema } from "./budget.js";
export type { BudgetExceededEvent } from "./budget.js";
export { LlmFailedEventSchema, RetryScheduledEventSchema, RetryStartedEventSchema } from "./llm.js";
export { RunTimedOutEventSchema } from "./run.js";
export type { RunTimedOutEvent } from "./run.js";

export const AgentEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunTimedOutEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  StatusChangedEventSchema,
  ReasoningSummaryEventSchema,
  PlanUpdatedEventSchema,
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
  ToolOutputEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  FileReadEventSchema,
  FileCreatedEventSchema,
  FileModifiedEventSchema,
  FileMovedEventSchema,
  FileDeletedEventSchema,
  ShellStartedEventSchema,
  ShellOutputEventSchema,
  ShellCompletedEventSchema,
  ProcessStartedEventSchema,
  ProcessOutputEventSchema,
  ProcessStoppedEventSchema,
  VerificationStartedEventSchema,
  VerificationCompletedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  LlmStartedEventSchema,
  LlmCompletedEventSchema,
  LlmFailedEventSchema,
  RetryScheduledEventSchema,
  RetryStartedEventSchema,
  ErrorEventSchema,
  BudgetExceededEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
