import {
  ToolObservationSchema,
  type ToolInvocation,
  type ToolObservation,
  type ObservationId,
  type RunId,
  type StepId,
  type TimestampMs,
  type ToolInvocationId,
  type JsonObject,
} from "@caelush/protocol";
import { cloneJsonValue, deepFreezeJson } from "./json-canonical.js";

export interface CreateToolObservationInput {
  readonly id: ObservationId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly toolInvocationId: ToolInvocationId;
  readonly rawArtifactRef?: string;
  readonly content: string;
  readonly details?: JsonObject;
  readonly isError: boolean;
  readonly createdAt: TimestampMs;
}

export function createToolObservation(input: CreateToolObservationInput): ToolObservation {
  const candidate: ToolObservation = {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId,
    kind: "TOOL",
    toolInvocationId: input.toolInvocationId,
    ...(input.rawArtifactRef === undefined ? {} : { rawArtifactRef: input.rawArtifactRef }),
    content: input.content,
    ...(input.details === undefined
      ? {}
      : { details: deepFreezeJson(cloneJsonValue(input.details)) as JsonObject }),
    isError: input.isError,
    createdAt: input.createdAt,
  };
  return Object.freeze(ToolObservationSchema.parse(candidate));
}

export function assertToolObservationInvariant(
  observation: ToolObservation,
  invocation: ToolInvocation,
): void {
  const parsed = ToolObservationSchema.parse(observation);
  if (
    parsed.runId !== invocation.runId ||
    parsed.stepId !== invocation.stepId ||
    parsed.toolInvocationId !== invocation.id
  ) {
    throw new Error("Tool observation does not belong to its invocation.");
  }
  if (invocation.status === "COMPLETED" && parsed.isError) {
    throw new Error("A completed tool invocation requires a non-error observation.");
  }
  if (invocation.status === "FAILED" && !parsed.isError) {
    throw new Error("A failed tool invocation requires an error observation.");
  }
  if (parsed.createdAt !== invocation.finishedAt) {
    throw new Error("Tool observation must use the settlement timestamp.");
  }
  if (
    invocation.status === "REQUESTED" ||
    invocation.status === "WAITING_APPROVAL" ||
    invocation.status === "RUNNING"
  ) {
    throw new Error("A non-terminal tool invocation cannot have a final observation.");
  }
}
