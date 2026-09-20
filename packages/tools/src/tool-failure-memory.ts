import { createHash } from "node:crypto";
import type { JsonObject, RunId, TimestampMs, ToolName } from "@caelush/protocol";
import { canonicalJsonString } from "./json-canonical.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES_PER_RUN = 64;

export interface ToolFailureMemoryInput {
  readonly runId: RunId;
  readonly toolName: ToolName;
  readonly args: JsonObject;
  /** A bounded stable code, never a raw handler message. */
  readonly failureCode: string;
  readonly now: TimestampMs;
}

export interface ToolFailureMemoryEntry {
  readonly runId: RunId;
  readonly toolName: ToolName;
  readonly argumentsFingerprint: string;
  readonly failureCode: string;
  readonly firstSeenAt: TimestampMs;
  readonly lastSeenAt: TimestampMs;
  readonly count: number;
}

export interface ToolFailureMemoryOptions {
  readonly ttlMs?: number;
  readonly maxEntriesPerRun?: number;
}

interface StoredEntry extends ToolFailureMemoryEntry {
  readonly key: string;
  readonly order: number;
}

/**
 * Host-only memory for model-recoverable failures. It stores only a canonical
 * argument fingerprint and a stable failure code, so raw arguments and
 * handler messages cannot leak through diagnostics or later model context.
 */
export class ToolFailureMemory {
  private readonly entriesByRun = new Map<RunId, Map<string, StoredEntry>>();
  private readonly ttlMs: number;
  private readonly maxEntriesPerRun: number;
  private nextOrder = 0;

  constructor(options: ToolFailureMemoryOptions = {}) {
    this.ttlMs = positiveSafeInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
    this.maxEntriesPerRun = positiveSafeInteger(
      options.maxEntriesPerRun ?? DEFAULT_MAX_ENTRIES_PER_RUN,
      "maxEntriesPerRun",
    );
  }

  has(input: ToolFailureMemoryInput): boolean {
    const failureCode = assertFailureCode(input.failureCode);
    const entries = this.prune(input.runId, input.now);
    return entries.has(makeKey({ ...input, failureCode }));
  }

  record(input: ToolFailureMemoryInput): void {
    const failureCode = assertFailureCode(input.failureCode);
    const entries = this.prune(input.runId, input.now);
    const normalizedInput = { ...input, failureCode };
    const key = makeKey(normalizedInput);
    const existing = entries.get(key);
    if (existing !== undefined) {
      entries.set(key, {
        ...existing,
        lastSeenAt: input.now,
        count: existing.count + 1,
      });
      return;
    }
    const argumentsFingerprint = fingerprint(input.args);
    entries.set(key, {
      key,
      order: this.nextOrder++,
      runId: input.runId,
      toolName: input.toolName,
      argumentsFingerprint,
      failureCode,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
      count: 1,
    });
    this.entriesByRun.set(input.runId, entries);
    this.enforceLimit(entries);
  }

  entries(runId: RunId, now?: TimestampMs): readonly ToolFailureMemoryEntry[] {
    const entries = now === undefined ? this.entriesByRun.get(runId) : this.prune(runId, now);
    if (entries === undefined) return [];
    return Object.freeze(
      [...entries.values()]
        .sort((left, right) => left.order - right.order)
        .map((entry) =>
          Object.freeze({
            runId: entry.runId,
            toolName: entry.toolName,
            argumentsFingerprint: entry.argumentsFingerprint,
            failureCode: entry.failureCode,
            firstSeenAt: entry.firstSeenAt,
            lastSeenAt: entry.lastSeenAt,
            count: entry.count,
          }),
        ),
    );
  }

  clearRun(runId: RunId): void {
    this.entriesByRun.delete(runId);
  }

  private prune(runId: RunId, now: TimestampMs): Map<string, StoredEntry> {
    const entries = this.entriesByRun.get(runId) ?? new Map<string, StoredEntry>();
    for (const [key, entry] of entries) {
      if (now - entry.lastSeenAt >= this.ttlMs) entries.delete(key);
    }
    if (entries.size > 0) this.entriesByRun.set(runId, entries);
    else this.entriesByRun.delete(runId);
    return entries;
  }

  private enforceLimit(entries: Map<string, StoredEntry>): void {
    if (entries.size <= this.maxEntriesPerRun) return;
    const oldest = [...entries.values()].sort((left, right) => left.order - right.order)[0];
    if (oldest !== undefined) entries.delete(oldest.key);
  }
}

function makeKey(input: ToolFailureMemoryInput): string {
  return `${input.toolName}\u0000${input.failureCode}\u0000${fingerprint(input.args)}`;
}

function assertFailureCode(value: string): string {
  if (!/^[A-Z0-9_]{1,64}$/.test(value)) {
    throw new Error("Tool failure code must be a bounded stable code.");
  }
  return value;
}

function fingerprint(args: JsonObject): string {
  return createHash("sha256").update(canonicalJsonString(args), "utf8").digest("hex");
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

/**
 * The failure memory as an admission pre-check.
 *
 * ## Why it moved
 *
 * Before Phase 4C the shell consulted this memory in front of its own durable path and then built a
 * `FAILED` invocation for the block, with its own observation and its own event — a second failure
 * settlement algorithm living beside the real one. Now the memory refuses the call **inside** the
 * canonical admission flow, and the durable coordinator settles that refusal exactly like a policy
 * denial:
 *
 * ```text
 * ToolAdmissionPreCheck returns DENY(feedback)
 *        ↓
 * DurableToolExecutionCoordinator
 *        ↓
 * the one failure settlement: FAILED invocation + safe observation + tool.failed event, atomically
 * ```
 *
 * The legacy shell no longer creates a `FAILED` invocation for anything.
 *
 * ## What it answers
 *
 * A recent, still-unexpired failure of the same Tool with the same canonical argument fingerprint
 * refuses the call with the same safe content and the same `TOOL_EXECUTION_ERROR` code it always did.
 * Nothing about the memory's own storage changes: still host-only, still an argument fingerprint plus a
 * stable code, never raw arguments.
 */
export function createToolFailureMemoryPreCheck(input: {
  readonly memory: ToolFailureMemory;
  readonly clock: { now(): TimestampMs };
}): {
  check(request: {
    readonly toolName: ToolName;
    readonly args: Readonly<JsonObject>;
    readonly identity: { readonly runId: RunId };
  }): import("@caelush/agent").ToolPolicyDecision | undefined;
} {
  return {
    check(request): import("@caelush/agent").ToolPolicyDecision | undefined {
      const blocked = input.memory.has({
        runId: request.identity.runId,
        toolName: request.toolName,
        args: request.args as JsonObject,
        failureCode: "TOOL_EXECUTION_ERROR",
        now: input.clock.now(),
      });
      if (!blocked) return undefined;
      return Object.freeze({
        kind: "DENY",
        feedback: Object.freeze({
          code: "TOOL_EXECUTION_ERROR",
          content: FAILURE_MEMORY_CONTENT,
          details: Object.freeze({ blockedBy: "TOOL_FAILURE_MEMORY" }),
          disposition: "SAFE_FAILURE" as const,
          blockToolFailures: true,
        }),
      });
    },
  };
}

const FAILURE_MEMORY_CONTENT =
  "This Tool call was blocked because the same Tool input recently failed. Change the arguments or choose another Tool.";

/**
 * The code a model-recoverable Tool **execution** failure is recorded under.
 *
 * A failure of this kind came from the call's own arguments or from the state they addressed, so
 * repeating the identical call is a repetition of a known failure. That is exactly the conclusion the
 * memory exists to reach, and it is what `blockToolFailures` on the feedback states.
 *
 * A *transient* refusal — a broken policy evaluator, a storage outage — never records here: the same
 * call may succeed a moment later, and refusing it would be refusing a call nobody concluded was
 * unrepeatable.
 */
export const TOOL_FAILURE_MEMORY_CODE = "TOOL_EXECUTION_ERROR";
