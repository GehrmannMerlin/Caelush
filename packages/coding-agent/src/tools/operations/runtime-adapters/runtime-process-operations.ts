import type { JsonObject } from "@caelush/ai";
import type { RuntimeExecResult, RuntimeResolver } from "@caelush/runtime";

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
 * ## `onOutput` is not invoked, and this file says so
 *
 * The contract carries an `onOutput` callback so a Tool can publish transient output as it arrives. The
 * first Runtime adapter has **no live streaming source**: `RuntimeExecService.execute()` is a
 * yield-and-return call, so there is no chunk to hand back while the process runs. This adapter
 * therefore never calls `onOutput`.
 *
 * It does not poll the session to manufacture chunks, and it does not claim realtime output. The seam
 * exists for two reasons that are both real today: a Runtime that later gains a live stream needs no
 * Tool change, and a fake Operations implementation in a unit test can already prove that the Coding
 * Tool projects the callback onto the canonical transient-update channel.
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
      });
      return toJsonObject(result);
    },
  };
}
