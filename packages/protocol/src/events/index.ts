import { z } from "zod";
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
  ToolOutputEventV2Schema,
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
  ShellOutputEventV2Schema,
  ShellStartedEventSchema,
} from "./shell.js";
import {
  ProcessOutputEventSchema,
  ProcessOutputEventV2Schema,
  ProcessStartedEventSchema,
  ProcessStoppedEventSchema,
} from "./process.js";
import {
  ModelReasoningSummaryDeltaEventSchema,
  ModelTextDeltaEventSchema,
  ModelToolCallDeltaEventSchema,
} from "./model.js";
import {
  VerificationCompletedEventSchema,
  VerificationCheckCompletedEventSchema,
  VerificationCheckStartedEventSchema,
  VerificationRepairLimitReachedEventSchema,
  VerificationRepairStartedEventSchema,
  VerificationPlannedEventSchema,
  VerificationStartedEventSchema,
  VerificationFinalizedEventSchema,
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
import { ResourceGuardEventSchema } from "./resource.js";
import { createPublicRunEventSchema, type PublicRunEventFrom } from "./public.js";
import { ConversationMessageCommittedEventSchema } from "./conversation.js";

export {
  CoalescibleTransientEventMetaSchema,
  DurableEventSchema,
  DurableRunEventMetaSchema,
  EphemeralEventSchema,
  EventDurabilitySchema,
  EventSchemaVersionSchema,
  EventVisibilitySchema,
  OrderedTransientEventMetaSchema,
  RunEventDurabilitySchema,
  TransientDeliveryClassSchema,
  TransientRunEventMetaSchema,
  createVersionedEventSchema,
} from "./base.js";
export type {
  CoalescibleTransientEventMeta,
  DurableEvent,
  DurableRunEventMeta,
  EphemeralEvent,
  EventDurability,
  EventSchemaVersion,
  EventVisibility,
  OrderedTransientEventMeta,
  RunEventBase,
  RunEventDurability,
  TransientDeliveryClass,
  TransientRunEventMeta,
} from "./base.js";
export {
  ModelReasoningSummaryDeltaEventSchema,
  ModelTextDeltaEventSchema,
  ModelToolCallDeltaEventSchema,
} from "./model.js";
export type {
  ModelReasoningSummaryDeltaEvent,
  ModelTextDeltaEvent,
  ModelToolCallDeltaEvent,
} from "./model.js";
export { ProcessOutputEventV2Schema } from "./process.js";
export type { ProcessOutputEventV2 } from "./process.js";
export { ShellOutputEventV2Schema } from "./shell.js";
export type { ShellOutputEventV2 } from "./shell.js";
export { ToolOutputEventV2Schema } from "./tool.js";
export type { ToolOutputEventV2 } from "./tool.js";
export {
  getRunEventTypeDefinition,
  RUN_EVENT_TYPE_CATALOG,
  RunEventTypeCatalog,
} from "./catalog.js";
export type { RunEventTypeDefinition } from "./catalog.js";
export { ConversationMessageCommittedEventSchema } from "./conversation.js";
export type { ConversationMessageCommittedEvent } from "./conversation.js";
export { createPublicRunEventSchema } from "./public.js";
export type { PublicRunEventFrom } from "./public.js";
export {
  RunEventSchemaDecodeError,
  RUN_EVENT_SCHEMA_REGISTRY,
  RunEventSchemaRegistryInstance,
} from "./registry.js";
export type { RunEventSchemaRegistry } from "./registry.js";
export { BudgetExceededEventSchema } from "./budget.js";
export type { BudgetExceededEvent } from "./budget.js";
export { ResourceGuardEventSchema } from "./resource.js";
export type { ResourceGuardEvent } from "./resource.js";
export { LlmFailedEventSchema, RetryScheduledEventSchema, RetryStartedEventSchema } from "./llm.js";
export { RunTimedOutEventSchema } from "./run.js";
export type { RunTimedOutEvent } from "./run.js";
export { VerificationPlannedEventSchema } from "./verification.js";
export {
  VerificationCheckCompletedEventSchema,
  VerificationCheckStartedEventSchema,
  VerificationRepairLimitReachedEventSchema,
  VerificationRepairStartedEventSchema,
  VerificationFinalizedEventSchema,
} from "./verification.js";

// A type may have multiple registered schema versions, so this union deliberately uses the
// version-aware static registry instead of Zod's single-discriminator optimization.
const currentRunEventSchema = z.union([
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
  ToolOutputEventV2Schema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  FileReadEventSchema,
  FileCreatedEventSchema,
  FileModifiedEventSchema,
  FileMovedEventSchema,
  FileDeletedEventSchema,
  ShellStartedEventSchema,
  ShellOutputEventSchema,
  ShellOutputEventV2Schema,
  ShellCompletedEventSchema,
  ProcessStartedEventSchema,
  ProcessOutputEventSchema,
  ProcessOutputEventV2Schema,
  ProcessStoppedEventSchema,
  VerificationStartedEventSchema,
  VerificationCompletedEventSchema,
  VerificationCheckStartedEventSchema,
  VerificationCheckCompletedEventSchema,
  VerificationPlannedEventSchema,
  VerificationRepairStartedEventSchema,
  VerificationRepairLimitReachedEventSchema,
  VerificationFinalizedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  LlmStartedEventSchema,
  LlmCompletedEventSchema,
  LlmFailedEventSchema,
  RetryScheduledEventSchema,
  RetryStartedEventSchema,
  ErrorEventSchema,
  BudgetExceededEventSchema,
  ResourceGuardEventSchema,
  ConversationMessageCommittedEventSchema,
  ModelTextDeltaEventSchema,
  ModelReasoningSummaryDeltaEventSchema,
  ModelToolCallDeltaEventSchema,
]);

/**
 * The parser remains compatibility-shaped in Phase 6A so historical v1 events, including the old
 * empty EPHEMERAL metadata, continue to decode. New producers must use the canonical metadata
 * contracts exported from base.ts; the runtime parser is intentionally not a second authority.
 */
export const RunEventSchema = currentRunEventSchema;
/** @deprecated Use RunEventSchema. */
export const AgentEventSchema = RunEventSchema;

export type RunEvent = z.infer<typeof RunEventSchema>;

export const PublicRunEventSchema = createPublicRunEventSchema(RunEventSchema);
export type PublicRunEvent = PublicRunEventFrom<RunEvent>;

type WithDurability<TEvent, TDurability> = TEvent extends { readonly type: string }
  ? Omit<TEvent, "durability"> & { readonly durability: TDurability }
  : never;

export type DurableRunEvent = WithDurability<RunEvent, import("./base.js").DurableRunEventMeta>;

export type TransientRunEvent = WithDurability<RunEvent, import("./base.js").TransientRunEventMeta>;

export type RunEventWithCanonicalDurability = DurableRunEvent | TransientRunEvent;

/** @deprecated Use RunEvent. */
export type AgentEvent = RunEvent;
