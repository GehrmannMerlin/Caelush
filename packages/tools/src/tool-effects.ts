import type {
  AgentState,
  EventId,
  FileChangeSummary,
  ProcessSummary,
  SessionId,
  TimestampMs,
  ToolInvocationId,
} from "@caelush/protocol";
import type { ToolExecutionRequest } from "./handler.js";
import type { ToolExecutionResult } from "./execution-result.js";
import type { DurableToolEventDraft } from "./dispatcher-types.js";

export const SAFE_SHELL_COMMAND_LABEL = "shell command";
export const MAX_CHANGED_FILES = 500;

export function effectsChangeAgentState(effects: readonly ToolEffect[]): boolean {
  return effects.some(
    (effect) =>
      effect.type === "FILE_CHANGE" ||
      effect.type === "PROCESS_STARTED" ||
      effect.type === "PROCESS_STOPPED",
  );
}

export type ToolEffect =
  | { readonly type: "FILE_READ"; readonly path: string }
  | {
      readonly type: "FILE_CHANGE";
      readonly summary: FileChangeSummary;
      readonly fromPath?: string;
      readonly toPath?: string;
    }
  | { readonly type: "SHELL_STARTED"; readonly invocationId: ToolInvocationId }
  | {
      readonly type: "SHELL_COMPLETED";
      readonly invocationId: ToolInvocationId;
      readonly exitCode?: number;
      readonly signal?: string;
    }
  | { readonly type: "PROCESS_STARTED"; readonly sessionId: string }
  | { readonly type: "PROCESS_STOPPED"; readonly sessionId: string };

export interface ToolEffectProjectorInput {
  readonly request: ToolExecutionRequest;
  readonly result: ToolExecutionResult;
  readonly now: TimestampMs;
}

export type ToolEffectProjector = (input: ToolEffectProjectorInput) => readonly ToolEffect[];

export function applyToolEffectsToAgentState(
  state: AgentState,
  effects: readonly ToolEffect[],
  now: TimestampMs,
): AgentState {
  let changedFiles = [...state.changedFiles];
  let activeProcesses = [...state.activeProcesses];
  for (const effect of effects) {
    if (effect.type === "FILE_CHANGE") {
      const removed = new Set([effect.summary.path, effect.fromPath, effect.toPath]);
      changedFiles = changedFiles.filter((file) => !removed.has(file.path));
      changedFiles.push(effect.summary);
    } else if (effect.type === "PROCESS_STARTED") {
      const process: ProcessSummary = {
        id: effect.sessionId,
        command: SAFE_SHELL_COMMAND_LABEL,
        status: "RUNNING",
      };
      activeProcesses = activeProcesses.filter((entry) => entry.id !== effect.sessionId);
      activeProcesses.push(process);
    } else if (effect.type === "PROCESS_STOPPED") {
      activeProcesses = activeProcesses.filter((entry) => entry.id !== effect.sessionId);
    }
  }
  return {
    ...state,
    changedFiles: changedFiles.slice(-MAX_CHANGED_FILES),
    activeProcesses,
    updatedAt: now,
  };
}

export interface ToolEffectEventContext {
  readonly runId: import("@caelush/protocol").RunId;
  readonly sessionId: SessionId;
  readonly stepId: import("@caelush/protocol").StepId;
  readonly timestamp: TimestampMs;
  readonly nextEventId: () => EventId;
}

export function toolEffectsToEvents(
  effects: readonly ToolEffect[],
  context: ToolEffectEventContext,
): readonly DurableToolEventDraft[] {
  return effects.map((effect) => {
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
    switch (effect.type) {
      case "FILE_READ":
        return { ...base, type: "file.read" as const, payload: { path: effect.path } };
      case "FILE_CHANGE":
        if (effect.summary.changeType === "CREATED")
          return { ...base, type: "file.created" as const, payload: { summary: effect.summary } };
        if (effect.summary.changeType === "MODIFIED")
          return { ...base, type: "file.modified" as const, payload: { summary: effect.summary } };
        if (effect.summary.changeType === "DELETED")
          return { ...base, type: "file.deleted" as const, payload: { summary: effect.summary } };
        return {
          ...base,
          type: "file.moved" as const,
          payload: {
            fromPath: effect.fromPath ?? effect.summary.path,
            toPath: effect.toPath ?? effect.summary.path,
          },
        };
      case "SHELL_STARTED":
        return {
          ...base,
          type: "shell.started" as const,
          payload: { invocationId: effect.invocationId, command: SAFE_SHELL_COMMAND_LABEL },
        };
      case "SHELL_COMPLETED":
        return {
          ...base,
          type: "shell.completed" as const,
          payload: {
            invocationId: effect.invocationId,
            ...(effect.exitCode === undefined ? {} : { exitCode: effect.exitCode }),
            ...(effect.signal === undefined ? {} : { signal: effect.signal }),
          },
        };
      case "PROCESS_STARTED":
        return {
          ...base,
          type: "process.started" as const,
          payload: {
            process: {
              id: effect.sessionId,
              command: SAFE_SHELL_COMMAND_LABEL,
              status: "RUNNING" as const,
            },
          },
        };
      case "PROCESS_STOPPED":
        return {
          ...base,
          type: "process.stopped" as const,
          payload: { processId: effect.sessionId, status: "EXITED" as const },
        };
    }
  });
}

export function projectReadFileEffect(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  const value = input.result.details.path;
  return input.result.isError || typeof value !== "string"
    ? []
    : [{ type: "FILE_READ", path: value }];
}

export function projectPatchEffects(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  if (input.result.isError || !Array.isArray(input.result.details.changes)) return [];
  const effects: ToolEffect[] = [];
  for (const item of input.result.details.changes) {
    if (item === null || typeof item !== "object") continue;
    const change = item as Record<string, unknown>;
    const additions = typeof change.additions === "number" ? change.additions : undefined;
    const deletions = typeof change.deletions === "number" ? change.deletions : undefined;
    if (change.kind === "MOVE" && typeof change.toPath === "string") {
      effects.push({
        type: "FILE_CHANGE",
        ...(typeof change.fromPath === "string" ? { fromPath: change.fromPath } : {}),
        toPath: change.toPath,
        summary: {
          path: change.toPath,
          changeType: "MOVED",
          ...(additions === undefined ? {} : { additions }),
          ...(deletions === undefined ? {} : { deletions }),
        },
      });
    } else if (
      (change.kind === "ADD" || change.kind === "UPDATE" || change.kind === "DELETE") &&
      typeof change.path === "string"
    ) {
      const changeType =
        change.kind === "ADD" ? "CREATED" : change.kind === "UPDATE" ? "MODIFIED" : "DELETED";
      effects.push({
        type: "FILE_CHANGE",
        summary: {
          path: change.path,
          changeType,
          ...(additions === undefined ? {} : { additions }),
          ...(deletions === undefined ? {} : { deletions }),
        },
      });
    }
  }
  return effects;
}

export function projectExecEffects(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  if (input.result.isError) return [];
  const effects: ToolEffect[] = [
    { type: "SHELL_STARTED", invocationId: input.request.invocationId },
  ];
  if (
    input.result.details.status === "RUNNING" &&
    typeof input.result.details.sessionId === "string"
  )
    effects.push({ type: "PROCESS_STARTED", sessionId: input.result.details.sessionId });
  else if (input.result.details.status === "EXITED")
    effects.push({
      type: "SHELL_COMPLETED",
      invocationId: input.request.invocationId,
      ...terminalFields(input.result.details),
    });
  return effects;
}

export function projectStdinEffects(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  const sessionId = input.request.args.session_id;
  if (
    input.result.isError ||
    input.result.details.status !== "EXITED" ||
    typeof sessionId !== "string"
  )
    return [];
  return [{ type: "PROCESS_STOPPED", sessionId }];
}

function terminalFields(details: Record<string, unknown>): {
  readonly exitCode?: number;
  readonly signal?: string;
} {
  return {
    ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
    ...(typeof details.signal === "string" ? { signal: details.signal } : {}),
  };
}
