import {
  ToolInvocationSchema,
  type AgentError,
  type JsonObject,
  type RiskLevel,
  type StepId,
  type TimestampMs,
  type ToolInvocation,
  type ToolInvocationId,
  type ToolName,
  type RunId,
} from "@caelush/protocol";
import { cloneJsonValue, deepFreezeJson } from "./json-canonical.js";
import { assertToolObservationInvariant, createToolObservation } from "./observation.js";

export interface CreateRequestedToolInvocationInput {
  readonly id: ToolInvocationId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly toolName: ToolName;
  readonly externalCallId: string;
  readonly args: JsonObject;
  readonly riskLevel: RiskLevel;
  readonly createdAt: TimestampMs;
}

const allowedTransitions: Readonly<Record<string, readonly string[]>> = {
  REQUESTED: ["WAITING_APPROVAL", "RUNNING", "FAILED"],
  WAITING_APPROVAL: ["RUNNING", "FAILED"],
  RUNNING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function assertToolInvocationTransition(
  from: ToolInvocation["status"],
  to: ToolInvocation["status"],
): void {
  if (!(allowedTransitions[from] ?? []).includes(to)) {
    throw new Error(`Invalid ToolInvocation transition: ${from} -> ${to}`);
  }
}

export function createRequestedToolInvocation(
  input: CreateRequestedToolInvocationInput,
): ToolInvocation {
  const invocation: ToolInvocation = {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId,
    toolName: input.toolName,
    externalCallId: input.externalCallId,
    args: deepFreezeJson(cloneJsonValue(input.args)) as JsonObject,
    riskLevel: input.riskLevel,
    status: "REQUESTED",
    createdAt: input.createdAt,
  };
  const parsed = ToolInvocationSchema.parse(invocation);
  assertToolInvocationInvariant(parsed);
  return Object.freeze(parsed);
}

export function markToolInvocationWaitingApproval(invocation: ToolInvocation): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "WAITING_APPROVAL");
  return replaceInvocation(invocation, { status: "WAITING_APPROVAL" });
}

export function startToolInvocation(
  invocation: ToolInvocation,
  startedAt: TimestampMs,
): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "RUNNING");
  return replaceInvocation(invocation, { status: "RUNNING", startedAt });
}

export function completeToolInvocation(
  invocation: ToolInvocation,
  finishedAt: TimestampMs,
): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "COMPLETED");
  return replaceInvocation(invocation, { status: "COMPLETED", finishedAt });
}

export function failToolInvocation(
  invocation: ToolInvocation,
  error: AgentError,
  finishedAt: TimestampMs,
): ToolInvocation {
  assertToolInvocationTransition(invocation.status, "FAILED");
  return replaceInvocation(invocation, { status: "FAILED", error, finishedAt });
}

export function assertToolInvocationInvariant(invocation: ToolInvocation): void {
  const parsed = ToolInvocationSchema.parse(invocation);
  if (parsed.externalCallId !== undefined && parsed.externalCallId.trim().length === 0) {
    throw new Error("Tool invocation externalCallId must be non-empty.");
  }
  switch (parsed.status) {
    case "REQUESTED":
    case "WAITING_APPROVAL":
      requireAbsent(parsed.startedAt, "startedAt", parsed.status);
      requireAbsent(parsed.finishedAt, "finishedAt", parsed.status);
      requireAbsent(parsed.error, "error", parsed.status);
      return;
    case "RUNNING":
      requireStarted(parsed);
      requireAbsent(parsed.finishedAt, "finishedAt", parsed.status);
      requireAbsent(parsed.error, "error", parsed.status);
      return;
    case "COMPLETED":
      requireStarted(parsed);
      requireFinished(parsed);
      requireAbsent(parsed.error, "error", parsed.status);
      return;
    case "FAILED":
      if (parsed.startedAt !== undefined) requireStarted(parsed);
      requireFinished(parsed);
      if (parsed.error === undefined) throw new Error("Failed tool invocation requires error.");
      return;
    case "CANCELLED":
      if (parsed.startedAt !== undefined) requireStarted(parsed);
      requireFinished(parsed);
      return;
  }
}

function replaceInvocation(
  invocation: ToolInvocation,
  changes: Partial<Pick<ToolInvocation, "status" | "startedAt" | "finishedAt" | "error">>,
): ToolInvocation {
  const candidate = ToolInvocationSchema.parse({ ...invocation, ...changes });
  assertToolInvocationInvariant(candidate);
  return Object.freeze({
    ...candidate,
    args: deepFreezeJson(cloneJsonValue(candidate.args)) as JsonObject,
  });
}

function requireStarted(invocation: ToolInvocation): void {
  if (invocation.startedAt === undefined || invocation.startedAt < invocation.createdAt) {
    throw new Error("Tool invocation startedAt must be at or after createdAt.");
  }
}

function requireFinished(invocation: ToolInvocation): void {
  if (invocation.finishedAt === undefined)
    throw new Error("Terminal tool invocation requires finishedAt.");
  const lowerBound = invocation.startedAt ?? invocation.createdAt;
  if (invocation.finishedAt < lowerBound) {
    throw new Error("Tool invocation finishedAt must not precede its lifecycle start.");
  }
}

function requireAbsent(value: unknown, field: string, status: string): void {
  if (value !== undefined) throw new Error(`${status} tool invocation cannot have ${field}.`);
}

export { assertToolObservationInvariant, createToolObservation };
export type { CreateToolObservationInput } from "./observation.js";
