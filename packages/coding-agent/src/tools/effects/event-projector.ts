import type { JsonObject } from "@caelush/ai";
import type { EventId, RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";
import type { ToolPresentationPort } from "@caelush/agent";

import { SAFE_SHELL_COMMAND_LABEL, type ToolEffect } from "./effects.js";

/**
 * Project Coding Tool effects into the durable host-domain events they imply.
 *
 * ```text
 * FILE_READ        →  file.read
 * FILE_CHANGE      →  file.created | file.modified | file.deleted | file.moved
 * SHELL_STARTED    →  shell.started
 * SHELL_COMPLETED  →  shell.completed
 * PROCESS_STARTED  →  process.started
 * PROCESS_STOPPED  →  process.stopped
 * ```
 *
 * ## The event discriminants are frozen wire values
 *
 * These nine type strings are what a host already consumes. They are not renamed, restructured or
 * merged here: an effect migration must not silently change the event a subscriber sees. The projectors
 * moved owner; the wire did not move.
 *
 * ## The shell label is best-effort, and its fallback is safe
 *
 * `shell.started` and `process.started` carry a command string. It is never the raw command: the
 * presentation layer is asked for a safe label, and if there is no presentation port, no invocation, or
 * the presenter throws, the fixed `SAFE_SHELL_COMMAND_LABEL` is used. A presentation failure must never
 * change whether the event is emitted, and must never cause the raw command to be substituted as a
 * "fallback".
 *
 * ## Identity is supplied, not invented
 *
 * `nextEventId` comes from the settlement's own factory, so an effect event and the terminal tool event
 * it accompanies are drawn from one durable sequence. A projector that generated ids would create a
 * second ordering authority.
 *
 * ## One cast, at the JSON boundary
 *
 * Each branch builds a payload whose shape is exact for its discriminant — `{ path }`, `{ summary }`,
 * `{ invocationId, command }`, `{ process }`, `{ fromPath, toPath }` — which is what makes a draft
 * checkable by reading it. TypeScript cannot prove those shapes satisfy the generic `JsonObject` index
 * signature, because `FileChangeSummary` carries optional numbers and an interface without an index
 * signature is not assignable to one. The payload is therefore cast once, in the single function whose
 * whole job is to produce these JSON payloads, and the Protocol schema validates the value that reaches
 * the durable event store.
 */
export interface ToolEffectEventContext {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly stepId: StepId;
  readonly timestamp: TimestampMs;
  readonly nextEventId: () => EventId;
  readonly invocation?: import("@caelush/protocol").ToolInvocation;
  readonly presentation?: ToolPresentationPort | undefined;
}

/** One durable effect event, before identity and durability are attached by the settlement. */
export interface CodingToolEffectEventDraft {
  readonly eventId: EventId;
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly stepId: StepId;
  readonly timestamp: TimestampMs;
  readonly visibility: "USER_VISIBLE";
  readonly durability: { readonly kind: "DURABLE"; readonly version: 1 };
  readonly type: string;
  readonly payload: JsonObject;
}

function safeShellCommandLabel(context: ToolEffectEventContext): string {
  if (context.presentation === undefined || context.invocation === undefined) {
    return SAFE_SHELL_COMMAND_LABEL;
  }
  try {
    return context.presentation.presentShellCommand({ invocation: context.invocation });
  } catch {
    // A presenter throw is a presentation bug. It must not change whether the event exists, and it
    // must not fall back to the raw command.
    return SAFE_SHELL_COMMAND_LABEL;
  }
}

export function toolEffectsToEvents(
  effects: readonly ToolEffect[],
  context: ToolEffectEventContext,
): readonly CodingToolEffectEventDraft[] {
  return effects.map((effect): CodingToolEffectEventDraft => {
    const base = {
      eventId: context.nextEventId(),
      schemaVersion: 1 as const,
      runId: context.runId,
      sessionId: context.sessionId,
      stepId: context.stepId,
      timestamp: context.timestamp,
      visibility: "USER_VISIBLE" as const,
      durability: { kind: "DURABLE" as const, version: 1 as const },
    };
    // The payloads below are exact for their discriminant. The cast crosses the boundary between a
    // precisely-shaped object and the generic JSON index signature once, here, where the payloads are
    // produced; the Protocol schema validates what reaches the durable event store.
    const payload = (value: unknown): JsonObject => value as JsonObject;
    switch (effect.type) {
      case "FILE_READ":
        return { ...base, type: "file.read", payload: payload({ path: effect.path }) };
      case "FILE_CHANGE":
        if (effect.summary.changeType === "CREATED") {
          return { ...base, type: "file.created", payload: payload({ summary: effect.summary }) };
        }
        if (effect.summary.changeType === "MODIFIED") {
          return { ...base, type: "file.modified", payload: payload({ summary: effect.summary }) };
        }
        if (effect.summary.changeType === "DELETED") {
          return { ...base, type: "file.deleted", payload: payload({ summary: effect.summary }) };
        }
        return {
          ...base,
          type: "file.moved",
          payload: payload({
            fromPath: effect.fromPath ?? effect.summary.path,
            toPath: effect.toPath ?? effect.summary.path,
          }),
        };
      case "SHELL_STARTED":
        return {
          ...base,
          type: "shell.started",
          payload: payload({
            invocationId: effect.invocationId,
            command: safeShellCommandLabel(context),
          }),
        };
      case "SHELL_COMPLETED":
        return {
          ...base,
          type: "shell.completed",
          payload: payload({
            invocationId: effect.invocationId,
            ...(effect.exitCode === undefined ? {} : { exitCode: effect.exitCode }),
            ...(effect.signal === undefined ? {} : { signal: effect.signal }),
          }),
        };
      case "PROCESS_STARTED":
        return {
          ...base,
          type: "process.started",
          payload: payload({
            process: {
              id: effect.sessionId,
              command: safeShellCommandLabel(context),
              status: "RUNNING",
            },
          }),
        };
      case "PROCESS_STOPPED":
        return {
          ...base,
          type: "process.stopped",
          payload: payload({
            processId: effect.sessionId,
            status: effect.status ?? "EXITED",
          }),
        };
    }
  });
}
