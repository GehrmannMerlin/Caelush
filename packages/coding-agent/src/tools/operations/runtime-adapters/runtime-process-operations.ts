import type { JsonObject } from "@caelush/ai";
import type { ProcessOutputEvent, RuntimeExecResult, RuntimeResolver } from "@caelush/runtime";

import type { ExecOperations, ProcessOperations } from "../operations.js";
import { resolveRuntimeWorkspace } from "./resolve-runtime-workspace.js";

/**
 * The Runtime implementation of `ExecOperations` and `ProcessOperations`.
 *
 * ```text
 * execute()   start a command, binding the process to its owner Run
 * interact()  write to, or poll, a process this Run owns
 * ```
 *
 * Both return the Runtime's exec result projected onto a `JsonObject`, which is what the frozen
 * contracts specify: the Runtime's exec result schema is still evolving, and the boundary frozen here is
 * the capability rather than the result vocabulary.
 *
 * ## `onOutput` is a neutral live callback
 *
 * Runtime owns the process output callback and this adapter only changes its shape to the frozen
 * Coding Operations callback. It does not create RunEvents, choose delivery classes, or persist
 * anything; the daemon/Coding composition owns that projection.
 *
 * ## Uncertain process state is preserved
 *
 * `RuntimeProcessStaleSessionError` and `RuntimeProcessUncertainError` pass through untouched, so the
 * Coding Tool can map them onto the canonical uncertain-side-effect vocabulary. A process whose state
 * cannot be proven must never be downgraded into "session not found", because the model's response to
 * the two is opposite: one invites a retry, the other must not.
 */
function toJsonObject(result: RuntimeExecResult): JsonObject {
  return {
    status: result.status,
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    output: result.output,
    totalOutputBytes: result.totalOutputBytes,
    omittedBytes: result.omittedBytes,
    ...(result.tty === undefined ? {} : { tty: result.tty }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.charsAcceptedBytes === undefined
      ? {}
      : { charsAcceptedBytes: result.charsAcceptedBytes }),
  };
}

export function createRuntimeProcessOperations(
  resolver: RuntimeResolver,
): ExecOperations & ProcessOperations {
  return {
    async execute(input) {
      const scope = await resolveRuntimeWorkspace(resolver, input.environment);
      const result = await scope.exec.execute({
        ownerRunId: input.ownerRunId,
        signal: input.signal,
        command: input.command,
        ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
        tty: input.tty,
        yieldTimeMs: input.yieldTimeMs,
        ...(input.onOutput === undefined
          ? {}
          : {
              onOutput: (event: ProcessOutputEvent) => input.onOutput?.(event.stream, event.text),
            }),
      });
      return toJsonObject(result);
    },

    async interact(input) {
      const scope = await resolveRuntimeWorkspace(resolver, input.environment);
      const result = await scope.exec.interact({
        ownerRunId: input.ownerRunId,
        signal: input.signal,
        sessionId: input.sessionId,
        chars: input.chars,
        yieldTimeMs: input.yieldTimeMs,
        ...(input.onOutput === undefined
          ? {}
          : {
              onOutput: (event: ProcessOutputEvent) => input.onOutput?.(event.stream, event.text),
            }),
      });
      return toJsonObject(result);
    },
  };
}
