import { z } from "zod";
import type { RunEvent } from "./index.js";
import { getRunEventTypeDefinition, RUN_EVENT_TYPE_CATALOG } from "./catalog.js";
import { ApprovalRequestedEventSchema, ApprovalResolvedEventSchema } from "./approval.js";
import { BudgetExceededEventSchema } from "./budget.js";
import { ConversationMessageCommittedEventSchema } from "./conversation.js";
import { ErrorEventSchema } from "./error.js";
import {
  FileCreatedEventSchema,
  FileDeletedEventSchema,
  FileModifiedEventSchema,
  FileMovedEventSchema,
  FileReadEventSchema,
} from "./file.js";
import {
  LlmCompletedEventSchema,
  LlmFailedEventSchema,
  LlmStartedEventSchema,
  RetryScheduledEventSchema,
  RetryStartedEventSchema,
} from "./llm.js";
import {
  ProcessOutputEventSchema,
  ProcessStartedEventSchema,
  ProcessStoppedEventSchema,
} from "./process.js";
import { PlanUpdatedEventSchema, ReasoningSummaryEventSchema } from "./reasoning.js";
import { ResourceGuardEventSchema } from "./resource.js";
import {
  RunCancelledEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunStartedEventSchema,
  RunTimedOutEventSchema,
  StatusChangedEventSchema,
} from "./run.js";
import {
  ShellCompletedEventSchema,
  ShellOutputEventSchema,
  ShellStartedEventSchema,
} from "./shell.js";
import {
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  ToolOutputEventSchema,
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
} from "./tool.js";
import {
  VerificationCheckCompletedEventSchema,
  VerificationCheckStartedEventSchema,
  VerificationCompletedEventSchema,
  VerificationFinalizedEventSchema,
  VerificationPlannedEventSchema,
  VerificationRepairLimitReachedEventSchema,
  VerificationRepairStartedEventSchema,
  VerificationStartedEventSchema,
} from "./verification.js";

export interface RunEventSchemaRegistry {
  supports(type: string, version: number): boolean;
  parse(input: unknown): RunEvent;
}

export class RunEventSchemaDecodeError extends Error {
  readonly reason: "INVALID_DISCRIMINANT" | "UNSUPPORTED_TYPE" | "UNSUPPORTED_VERSION";

  constructor(
    reason: RunEventSchemaDecodeError["reason"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RunEventSchemaDecodeError";
    this.reason = reason;
  }
}

type RegisteredSchema = z.ZodTypeAny;

const registeredSchemas: ReadonlyMap<string, RegisteredSchema> = new Map<string, RegisteredSchema>([
  ["run.started\u00001", RunStartedEventSchema],
  ["run.timed_out\u00001", RunTimedOutEventSchema],
  ["run.completed\u00001", RunCompletedEventSchema],
  ["run.failed\u00001", RunFailedEventSchema],
  ["run.cancelled\u00001", RunCancelledEventSchema],
  ["status.changed\u00001", StatusChangedEventSchema],
  ["reasoning.summary\u00001", ReasoningSummaryEventSchema],
  ["plan.updated\u00001", PlanUpdatedEventSchema],
  ["tool.requested\u00001", ToolRequestedEventSchema],
  ["tool.started\u00001", ToolStartedEventSchema],
  ["tool.output\u00001", ToolOutputEventSchema],
  ["tool.completed\u00001", ToolCompletedEventSchema],
  ["tool.failed\u00001", ToolFailedEventSchema],
  ["file.read\u00001", FileReadEventSchema],
  ["file.created\u00001", FileCreatedEventSchema],
  ["file.modified\u00001", FileModifiedEventSchema],
  ["file.moved\u00001", FileMovedEventSchema],
  ["file.deleted\u00001", FileDeletedEventSchema],
  ["shell.started\u00001", ShellStartedEventSchema],
  ["shell.output\u00001", ShellOutputEventSchema],
  ["shell.completed\u00001", ShellCompletedEventSchema],
  ["process.started\u00001", ProcessStartedEventSchema],
  ["process.output\u00001", ProcessOutputEventSchema],
  ["process.stopped\u00001", ProcessStoppedEventSchema],
  ["verification.started\u00001", VerificationStartedEventSchema],
  ["verification.completed\u00001", VerificationCompletedEventSchema],
  ["verification.check.started\u00001", VerificationCheckStartedEventSchema],
  ["verification.check.completed\u00001", VerificationCheckCompletedEventSchema],
  ["verification.planned\u00001", VerificationPlannedEventSchema],
  ["verification.repair.started\u00001", VerificationRepairStartedEventSchema],
  ["verification.repair.limit_reached\u00001", VerificationRepairLimitReachedEventSchema],
  ["verification.finalized\u00001", VerificationFinalizedEventSchema],
  ["approval.requested\u00001", ApprovalRequestedEventSchema],
  ["approval.resolved\u00001", ApprovalResolvedEventSchema],
  ["llm.started\u00001", LlmStartedEventSchema],
  ["llm.completed\u00001", LlmCompletedEventSchema],
  ["llm.failed\u00001", LlmFailedEventSchema],
  ["retry.scheduled\u00001", RetryScheduledEventSchema],
  ["retry.started\u00001", RetryStartedEventSchema],
  ["error\u00001", ErrorEventSchema],
  ["budget.exceeded\u00001", BudgetExceededEventSchema],
  ["resource.guard\u00001", ResourceGuardEventSchema],
  ["conversation.message.committed\u00001", ConversationMessageCommittedEventSchema],
]);

for (const definition of RUN_EVENT_TYPE_CATALOG) {
  if (!registeredSchemas.has(`${definition.type}\u0000${definition.schemaVersion}`)) {
    throw new Error(
      `Run event catalog entry is not registered: ${definition.type}@${definition.schemaVersion}`,
    );
  }
}
for (const key of registeredSchemas.keys()) {
  const separator = key.lastIndexOf("\u0000");
  const type = key.slice(0, separator);
  const version = Number(key.slice(separator + 1));
  if (getRunEventTypeDefinition(type, version) === undefined) {
    throw new Error(`Run event schema is missing from the catalog: ${type}@${version}`);
  }
}

class StaticRunEventSchemaRegistry implements RunEventSchemaRegistry {
  supports(type: string, version: number): boolean {
    return registeredSchemas.has(`${type}\u0000${version}`);
  }

  parse(input: unknown): RunEvent {
    const record = readDiscriminants(input);
    if (record === undefined) {
      throw new RunEventSchemaDecodeError(
        "INVALID_DISCRIMINANT",
        "Run event must contain string type and numeric schemaVersion discriminants",
      );
    }
    const key = `${record.type}\u0000${record.schemaVersion}`;
    const schema = registeredSchemas.get(key);
    if (schema === undefined) {
      if (
        [...registeredSchemas.keys()].some((registered) =>
          registered.startsWith(`${record.type}\u0000`),
        )
      ) {
        throw new RunEventSchemaDecodeError(
          "UNSUPPORTED_VERSION",
          `Unsupported event schema version ${record.schemaVersion} for ${record.type}`,
        );
      }
      throw new RunEventSchemaDecodeError(
        "UNSUPPORTED_TYPE",
        `Unsupported event type ${record.type}`,
      );
    }
    try {
      return schema.parse(input) as RunEvent;
    } catch (error) {
      throw new RunEventSchemaDecodeError(
        "INVALID_DISCRIMINANT",
        `Invalid payload for event ${record.type} schema version ${record.schemaVersion}`,
        { cause: error },
      );
    }
  }
}

function readDiscriminants(
  input: unknown,
): { readonly type: string; readonly schemaVersion: number } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.schemaVersion !== "number" ||
    !Number.isSafeInteger(record.schemaVersion) ||
    record.schemaVersion <= 0
  ) {
    return undefined;
  }
  return { type: record.type, schemaVersion: record.schemaVersion };
}

/** Immutable-in-practice registry assembled from this package's static schema set. */
export const RUN_EVENT_SCHEMA_REGISTRY: RunEventSchemaRegistry = new StaticRunEventSchemaRegistry();

export const RunEventSchemaRegistryInstance = RUN_EVENT_SCHEMA_REGISTRY;
