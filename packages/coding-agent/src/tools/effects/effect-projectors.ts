import type { JsonObject } from "@caelush/ai";
import type { ToolInvocationId } from "@caelush/protocol";

import type { ToolEffect } from "./effects.js";

/**
 * Project one settled Tool result onto the effects it had.
 *
 * ```text
 * a successful, validated result  →  the facts it implies
 * an error or uncertain outcome   →  nothing at all
 * ```
 *
 * ## A projector is a fact producer, not a state mutator
 *
 * Every function here is pure: given the same invocation identity, arguments, result and timestamp it
 * returns the same effects and touches nothing. The state and event projections are separate modules
 * precisely so that "what happened" can be decided once and consumed twice.
 *
 * ## Error and uncertain outcomes never fabricate an effect
 *
 * Each projector returns `[]` for an `isError` result. That is not caution for its own sake: an effect
 * asserts that something *did* happen to the workspace, and a failed call is the one case where that is
 * unknowable. A fabricated `FILE_CHANGE` on a failed patch would put a file into `changedFiles` that may
 * never have been written.
 *
 * A projector that throws leaves the invocation `RUNNING` rather than inventing state — the settlement
 * treats a projection failure as an infrastructure failure, never as "no effects".
 */

/**
 * The projection input.
 *
 * `request.invocationId` is the durable invocation identity the `SHELL_STARTED` and `SHELL_COMPLETED`
 * effects carry, so an effect event can name the exact invocation that produced it.
 *
 * `request` also carries a JSON index signature because the projector crosses into the general
 * `CodingToolEffectProjector` contract, which types its request as `JsonObject`. The named fields are
 * the ones this vocabulary actually reads; the signature states that the value is a JSON object with
 * those fields, which is exactly what the settlement bridge supplies.
 */
export interface ToolEffectProjectorInput {
  readonly request: {
    readonly [key: string]: unknown;
    readonly invocationId: ToolInvocationId;
    readonly externalCallId: string;
    readonly args: JsonObject;
  };
  readonly result: {
    readonly content: string;
    readonly details: JsonObject;
    readonly isError: boolean;
  };
  readonly now: number;
}

export type ToolEffectProjector = (input: ToolEffectProjectorInput) => readonly ToolEffect[];

/** `read_file` → `FILE_READ` on the path the operation resolved to. */
export function projectReadFileEffect(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  const value = input.result.details.path;
  return input.result.isError || typeof value !== "string"
    ? []
    : [{ type: "FILE_READ", path: value }];
}

/**
 * `apply_patch` → one `FILE_CHANGE` per change the patch reported.
 *
 * A move is a single `FILE_CHANGE` whose summary path is the destination, carrying `fromPath` and
 * `toPath` so the state projection can remove the old path and the event projection can emit
 * `file.moved` with both ends.
 */
export function projectPatchEffects(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  if (input.result.isError || !Array.isArray(input.result.details.changes)) return [];
  const details = input.result.details as { readonly changes: readonly unknown[] };
  const effects: ToolEffect[] = [];
  for (const item of details.changes) {
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

/**
 * `exec_command` → `SHELL_STARTED`, plus either `PROCESS_STARTED` or `SHELL_COMPLETED`.
 *
 * A command that is still running produced a session, so it becomes an active process. A command that
 * exited produced a terminal outcome, so the shell is completed with its exit code and signal. The
 * distinction is what keeps `activeProcesses` honest: a finished command must not linger there.
 */
export function projectExecEffects(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  if (input.result.isError) return [];
  const details = input.result.details as {
    readonly status?: unknown;
    readonly sessionId?: unknown;
    readonly exitCode?: unknown;
    readonly signal?: unknown;
  };
  const effects: ToolEffect[] = [
    { type: "SHELL_STARTED", invocationId: input.request.invocationId },
  ];
  if (details.status === "RUNNING" && typeof details.sessionId === "string") {
    effects.push({ type: "PROCESS_STARTED", sessionId: details.sessionId });
  } else if (details.status === "EXITED") {
    effects.push({
      type: "SHELL_COMPLETED",
      invocationId: input.request.invocationId,
      ...terminalFields(details),
    });
  }
  return effects;
}

/**
 * `write_stdin` → `PROCESS_STOPPED` when an interaction proved the process ended.
 *
 * Only an `EXITED` result stops the process, and only a `KILLED` signal is recorded as a killed status.
 * An empty result means the process is still running or the outcome is unknown, and in both cases
 * leaving `activeProcesses` untouched is the honest answer.
 */
export function projectStdinEffects(input: ToolEffectProjectorInput): readonly ToolEffect[] {
  const sessionId = input.request.args.session_id;
  const details = input.result.details as { readonly status?: unknown; readonly signal?: unknown };
  if (input.result.isError || details.status !== "EXITED" || typeof sessionId !== "string") {
    return [];
  }
  return [
    {
      type: "PROCESS_STOPPED",
      sessionId,
      ...(details.signal === "KILLED" ? { status: "KILLED" as const } : {}),
    },
  ];
}

function terminalFields(details: { readonly exitCode?: unknown; readonly signal?: unknown }): {
  readonly exitCode?: number;
  readonly signal?: string;
} {
  return {
    ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
    ...(typeof details.signal === "string" ? { signal: details.signal } : {}),
  };
}
