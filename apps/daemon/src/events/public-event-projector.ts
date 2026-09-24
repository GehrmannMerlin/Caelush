import {
  PublicRunEventSchema,
  getRunEventTypeDefinition,
  type JsonObject,
  type JsonValue,
  type PublicRunEvent,
  type RunEvent,
} from "@caelush/protocol";
import {
  classifySensitivePath,
  normalizeWorkspaceFactPath,
  redactJson,
  redactText,
} from "@caelush/security";
import { sanitizeTerminalOutput } from "@caelush/runtime";

export const PUBLIC_EVENT_TEXT_BYTES = 8 * 1024;
export const PUBLIC_EVENT_COMMAND_BYTES = 4 * 1024;
export const PUBLIC_EVENT_OUTPUT_BYTES = 8 * 1024;
export const PUBLIC_EVENT_PLAN_ITEM_BYTES = 2 * 1024;
export const MAX_PUBLIC_EVENT_BYTES = 128 * 1024;

const MAX_PUBLIC_JSON_DEPTH = 6;
const MAX_PUBLIC_JSON_NODES = 512;
const MAX_PUBLIC_JSON_ITEMS = 64;
const PATH_PLACEHOLDER = "[path omitted]";
const SENSITIVE_PATH_PLACEHOLDER = "[sensitive path]";
const TEXT_PLACEHOLDER = "[value omitted]";

export interface PublicEventProjector {
  project(event: RunEvent): PublicRunEvent | null;
}

export class DefaultPublicEventProjector implements PublicEventProjector {
  project(event: RunEvent): PublicRunEvent | null {
    if (event.visibility !== "USER_VISIBLE") return null;
    const definition = getRunEventTypeDefinition(event.type, event.schemaVersion);
    if (definition?.visibility !== "USER_VISIBLE") return null;

    let payload: unknown;
    switch (event.type) {
      case "run.started":
        payload = { goal: nonEmptyText(event.payload.goal, "Run") };
        break;
      case "run.timed_out":
        payload = { deadlineAt: event.payload.deadlineAt };
        break;
      case "run.completed":
        payload = { result: projectSafeJson(event.payload.result) };
        break;
      case "run.failed":
        payload = { error: projectError(event.payload.error) };
        break;
      case "run.cancelled":
        payload = { reason: nonEmptyText(event.payload.reason, "Cancelled") };
        break;
      case "status.changed":
        payload = { from: event.payload.from, to: event.payload.to };
        break;
      case "reasoning.summary":
        payload = { summary: nonEmptyText(event.payload.summary, "Summary unavailable") };
        break;
      case "model.text.delta":
        payload = { text: boundedText(event.payload.text, PUBLIC_EVENT_TEXT_BYTES) };
        break;
      case "model.reasoning_summary.delta":
        payload = { text: boundedText(event.payload.text, PUBLIC_EVENT_TEXT_BYTES) };
        break;
      case "model.tool_call.delta":
        payload = {
          toolCallId: boundedText(event.payload.toolCallId, PUBLIC_EVENT_TEXT_BYTES),
          delta: terminalText(event.payload.delta, PUBLIC_EVENT_OUTPUT_BYTES),
        };
        break;
      case "plan.updated":
        payload = {
          plan: event.payload.plan.slice(0, 32).map((item) => ({
            id: item.id,
            title: nonEmptyBoundedText(item.title, "Plan item", PUBLIC_EVENT_PLAN_ITEM_BYTES),
            ...(item.detail === undefined
              ? {}
              : { detail: boundedText(item.detail, PUBLIC_EVENT_PLAN_ITEM_BYTES) }),
            status: item.status,
          })),
        };
        break;
      case "tool.requested":
        payload = {
          invocationId: event.payload.invocationId,
          toolName: event.payload.toolName,
          ...(event.payload.externalCallId === undefined
            ? {}
            : {
                externalCallId: boundedText(event.payload.externalCallId, PUBLIC_EVENT_TEXT_BYTES),
              }),
          riskLevel: event.payload.riskLevel,
        };
        break;
      case "tool.started":
        payload = { invocationId: event.payload.invocationId };
        break;
      case "tool.output":
        payload = {
          invocationId: event.payload.invocationId,
          stream: event.payload.stream,
          chunk: terminalText(event.payload.chunk, PUBLIC_EVENT_OUTPUT_BYTES),
        };
        break;
      case "tool.completed":
        payload = {
          invocationId: event.payload.invocationId,
          observationId: event.payload.observationId,
        };
        break;
      case "tool.failed":
        payload = {
          invocationId: event.payload.invocationId,
          error: projectError(event.payload.error),
        };
        break;
      case "file.read":
        payload = { path: publicPath(event.payload.path) };
        break;
      case "file.created":
        payload = { summary: projectFileSummary(event.payload.summary) };
        break;
      case "file.modified":
        payload = { summary: projectFileSummary(event.payload.summary) };
        break;
      case "file.moved":
        payload = {
          fromPath: publicPath(event.payload.fromPath),
          toPath: publicPath(event.payload.toPath),
        };
        break;
      case "file.deleted":
        payload = { summary: projectFileSummary(event.payload.summary) };
        break;
      case "shell.started":
        payload = {
          invocationId: event.payload.invocationId,
          command: nonEmptyBoundedText(
            event.payload.command,
            "Run command",
            PUBLIC_EVENT_COMMAND_BYTES,
            true,
          ),
        };
        break;
      case "shell.output":
        payload = {
          invocationId: event.payload.invocationId,
          stream: event.payload.stream,
          chunk: terminalText(event.payload.chunk, PUBLIC_EVENT_OUTPUT_BYTES),
        };
        break;
      case "shell.completed":
        payload = {
          invocationId: event.payload.invocationId,
          ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }),
          ...(event.payload.signal === undefined
            ? {}
            : { signal: boundedText(event.payload.signal, PUBLIC_EVENT_TEXT_BYTES) }),
        };
        break;
      case "process.started":
        payload = {
          process: {
            id: event.payload.process.id,
            command: nonEmptyBoundedText(
              event.payload.process.command,
              "Process",
              PUBLIC_EVENT_COMMAND_BYTES,
              true,
            ),
            status: event.payload.process.status,
          },
        };
        break;
      case "process.output":
        payload = {
          processId: boundedText(event.payload.processId, PUBLIC_EVENT_TEXT_BYTES),
          stream: event.payload.stream,
          chunk: terminalText(event.payload.chunk, PUBLIC_EVENT_OUTPUT_BYTES),
        };
        break;
      case "process.stopped":
        payload = {
          processId: boundedText(event.payload.processId, PUBLIC_EVENT_TEXT_BYTES),
          status: event.payload.status,
        };
        break;
      case "verification.started":
        payload = {
          type: nonEmptyText(event.payload.type, "Verification"),
          ...(event.payload.command === undefined
            ? {}
            : {
                command: nonEmptyBoundedText(
                  event.payload.command,
                  "Verification",
                  PUBLIC_EVENT_COMMAND_BYTES,
                  true,
                ),
              }),
        };
        break;
      case "verification.completed":
        payload = { result: projectVerificationResult(event.payload.result) };
        break;
      case "verification.planned":
        payload = {
          planId: event.payload.planId,
          sourceStepId: event.payload.sourceStepId,
          checkCount: event.payload.checkCount,
          plannerVersion: boundedText(event.payload.plannerVersion, PUBLIC_EVENT_TEXT_BYTES),
          counts: event.payload.counts,
        };
        break;
      case "verification.check.started":
        payload = {
          planId: event.payload.planId,
          checkId: event.payload.checkId,
          ordinal: event.payload.ordinal,
          kind: event.payload.kind,
          purpose: event.payload.purpose,
          stage: event.payload.stage,
        };
        break;
      case "verification.check.completed":
        payload = {
          planId: event.payload.planId,
          checkId: event.payload.checkId,
          status: event.payload.status,
          evidenceIds: event.payload.evidenceIds.slice(0, 64),
          ...(event.payload.durationMs === undefined
            ? {}
            : { durationMs: event.payload.durationMs }),
        };
        break;
      case "verification.repair.started":
        payload = {
          failedPlanId: event.payload.failedPlanId,
          failedCheckIds: event.payload.failedCheckIds.slice(0, 32),
          repairCycle: event.payload.repairCycle,
        };
        break;
      case "verification.repair.limit_reached":
        payload = {
          planId: event.payload.planId,
          attemptedRepairs: event.payload.attemptedRepairs,
          maxAutoRepairs: event.payload.maxAutoRepairs,
        };
        break;
      case "verification.finalized":
        payload = {
          planId: event.payload.planId,
          outcome: event.payload.outcome,
          ...(event.payload.sealHash === undefined ? {} : { sealHash: event.payload.sealHash }),
          failedCheckIds: event.payload.failedCheckIds.slice(0, 32),
          errorCheckIds: event.payload.errorCheckIds.slice(0, 32),
        };
        break;
      case "approval.requested":
        payload = { approval: projectApproval(event.payload.approval) };
        break;
      case "approval.resolved":
        payload = {
          approvalId: event.payload.approvalId,
          status: event.payload.status,
          ...(event.payload.grantedScope === undefined
            ? {}
            : { grantedScope: event.payload.grantedScope }),
        };
        break;
      case "llm.started":
        payload = { model: projectModel(event.payload.model) };
        break;
      case "llm.completed":
        payload = { model: projectModel(event.payload.model), usage: event.payload.usage };
        break;
      case "llm.failed":
        payload = {
          model: projectModel(event.payload.model),
          error: projectError(event.payload.error),
        };
        break;
      case "retry.scheduled":
        payload = {
          attempt: event.payload.attempt,
          maxAttempts: event.payload.maxAttempts,
          delayMs: event.payload.delayMs,
          nextAttemptAt: event.payload.nextAttemptAt,
          errorCode: event.payload.errorCode,
        };
        break;
      case "retry.started":
        payload = { attempt: event.payload.attempt, maxAttempts: event.payload.maxAttempts };
        break;
      case "error":
        payload = { error: projectError(event.payload.error) };
        break;
      case "budget.exceeded":
        payload = event.payload;
        break;
      case "resource.guard":
        payload = event.payload;
        break;
      case "conversation.message.committed":
        payload = {
          messageId: event.payload.messageId,
          conversationTurnId: event.payload.conversationTurnId,
          messageType: event.payload.messageType,
        };
        break;
      default:
        return null;
    }

    const candidate = {
      eventId: event.eventId,
      schemaVersion: event.schemaVersion,
      runId: event.runId,
      sessionId: event.sessionId,
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      timestamp: event.timestamp,
      visibility: "USER_VISIBLE" as const,
      durability: event.durability,
      type: event.type,
      ...(event.title === undefined ? {} : { title: nonEmptyText(event.title, "Activity") }),
      ...(event.summary === undefined ? {} : { summary: nonEmptyText(event.summary, "Activity") }),
      payload,
    };
    const parsed = PublicRunEventSchema.safeParse(candidate);
    if (!parsed.success) return null;
    const serialized = JSON.stringify(parsed.data);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > MAX_PUBLIC_EVENT_BYTES
    ) {
      return null;
    }
    return parsed.data;
  }
}

function boundedText(value: string, maxBytes: number): string {
  return truncateUtf8(redactText(value), maxBytes);
}

function nonEmptyText(value: string, fallback: string): string {
  const bounded = boundedText(value, PUBLIC_EVENT_TEXT_BYTES);
  return bounded.length === 0 ? fallback : bounded;
}

function nonEmptyBoundedText(
  value: string,
  fallback: string,
  maxBytes: number,
  terminal = false,
): string {
  const bounded = terminal
    ? truncateUtf8(redactText(sanitizeTerminalOutput(value)), maxBytes)
    : truncateUtf8(redactText(value), maxBytes);
  return bounded.length === 0 ? fallback : bounded;
}

function terminalText(value: string, maxBytes: number): string {
  return truncateUtf8(redactText(sanitizeTerminalOutput(value)), maxBytes);
}

function publicPath(value: string): string {
  const normalized = normalizeWorkspaceFactPath(value);
  if (normalized === undefined) return PATH_PLACEHOLDER;
  return classifySensitivePath(normalized) === undefined
    ? boundedText(normalized, PUBLIC_EVENT_TEXT_BYTES)
    : SENSITIVE_PATH_PLACEHOLDER;
}

function projectError(error: {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly phase?: string | undefined;
}) {
  return {
    code: error.code,
    message: nonEmptyText(error.message, "Operation failed"),
    retryable: error.retryable,
    ...(error.phase === undefined ? {} : { phase: error.phase }),
  };
}

function projectFileSummary(summary: {
  readonly path: string;
  readonly changeType: string;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
}) {
  return {
    path: publicPath(summary.path),
    changeType: summary.changeType,
    ...(summary.additions === undefined ? {} : { additions: summary.additions }),
    ...(summary.deletions === undefined ? {} : { deletions: summary.deletions }),
  };
}

function projectModel(model: { readonly provider: string; readonly model: string }) {
  return {
    provider: nonEmptyText(model.provider, "provider"),
    model: nonEmptyText(model.model, "model"),
  };
}

function projectVerificationResult(result: {
  readonly id: string;
  readonly runId: string;
  readonly type: string;
  readonly command?: string | undefined;
  readonly status: string;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
  readonly startedAt: number;
  readonly finishedAt: number;
}) {
  return {
    id: result.id,
    runId: result.runId,
    type: nonEmptyText(result.type, "Verification"),
    ...(result.command === undefined
      ? {}
      : {
          command: nonEmptyBoundedText(
            result.command,
            "Verification",
            PUBLIC_EVENT_COMMAND_BYTES,
            true,
          ),
        }),
    status: result.status,
    ...(result.stdout === undefined
      ? {}
      : { stdout: terminalText(result.stdout, PUBLIC_EVENT_OUTPUT_BYTES) }),
    ...(result.stderr === undefined
      ? {}
      : { stderr: terminalText(result.stderr, PUBLIC_EVENT_OUTPUT_BYTES) }),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
}

function projectApproval(approval: {
  readonly id: string;
  readonly runId: string;
  readonly toolInvocationId: string;
  readonly riskLevel: string;
  readonly title: string;
  readonly reason: string;
  readonly action: JsonObject;
  readonly status: string;
  readonly scope: string;
  readonly grantedScope?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly createdAt: number;
  readonly resolvedAt?: number | undefined;
}) {
  return {
    id: approval.id,
    runId: approval.runId,
    toolInvocationId: approval.toolInvocationId,
    riskLevel: approval.riskLevel,
    title: nonEmptyText(approval.title, "Approval"),
    reason: nonEmptyText(approval.reason, "Approval requested"),
    action: projectSafeJson(approval.action) as JsonObject,
    status: approval.status,
    scope: approval.scope,
    ...(approval.grantedScope === undefined ? {} : { grantedScope: approval.grantedScope }),
    ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
    createdAt: approval.createdAt,
    ...(approval.resolvedAt === undefined ? {} : { resolvedAt: approval.resolvedAt }),
  };
}

function projectSafeJson(value: unknown): JsonValue {
  return projectJsonValue(redactJson(value), 0, { nodes: 0 });
}

function projectJsonValue(value: unknown, depth: number, state: { nodes: number }): JsonValue {
  state.nodes += 1;
  if (depth > MAX_PUBLIC_JSON_DEPTH || state.nodes > MAX_PUBLIC_JSON_NODES) return TEXT_PLACEHOLDER;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return projectJsonString(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PUBLIC_JSON_ITEMS)
      .map((item) => projectJsonValue(item, depth + 1, state));
  }
  if (typeof value !== "object") return TEXT_PLACEHOLDER;

  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_PUBLIC_JSON_ITEMS)) {
    if (isHiddenInternalKey(key)) continue;
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : projectJsonValue(item, depth + 1, state);
  }
  return output;
}

function projectJsonString(value: string): string {
  if (looksLikeHostOrTraversalPath(value)) return PATH_PLACEHOLDER;
  return boundedText(value, PUBLIC_EVENT_TEXT_BYTES);
}

function looksLikeHostOrTraversalPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  );
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization|private[_-]?key)/i.test(
    key,
  );
}

function isHiddenInternalKey(key: string): boolean {
  return /(?:chain[-_ ]?of[-_ ]?thought|reasoning|provider[-_ ]?response|^cause$|^stack$|^headers?$|^endpoint$)/i.test(
    key,
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "\n… output truncated …\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return takeUtf8(value, maxBytes);
  const contentBudget = maxBytes - markerBytes;
  const headBudget = Math.floor(contentBudget / 2);
  const head = takeUtf8(value, headBudget);
  const tail = takeUtf8FromEnd(value, contentBudget - Buffer.byteLength(head, "utf8"));
  return head + marker + tail;
}

function takeUtf8(value: string, maxBytes: number): string {
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function takeUtf8FromEnd(value: string, maxBytes: number): string {
  let result = "";
  let used = 0;
  for (const character of [...value].reverse()) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    result = character + result;
    used += bytes;
  }
  return result;
}
