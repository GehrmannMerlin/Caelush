import type { JsonObject } from "@caelush/ai";
import type { ToolSecurityContext } from "@caelush/agent";
import type { RunId } from "@caelush/protocol";
import type {
  AuthorizedRuntimeExecution,
  ProcessOutputEvent,
  RuntimeExecResult,
  RuntimeResolver,
} from "@caelush/runtime";

import type { ExecOperations, ProcessOperations } from "../operations.js";
import {
  createDefaultRuntimeProcessAuthorization,
  resolveRuntimeWorkspace,
} from "./resolve-runtime-workspace.js";

/**
 * The Runtime implementation of `ExecOperations` and `ProcessOperations`.
 *
 * ```text
 * execute()    start a command, binding the process to its owner Run
 * interact()   write to, or poll, a process this Run owns
 * terminate()  stop one managed session this Run owns
 * ```
 *
 * Both return the Runtime's exec result projected onto a `JsonObject`, which is what the frozen
 * contracts specify: the Runtime's exec result schema is still evolving, and the boundary frozen here is
 * the capability rather than the result vocabulary.
 *
 * ## Ownership is the Runtime's answer, not this adapter's
 *
 * Every request carries the caller's `ownerRunId` straight through. The adapter never inspects a
 * session id, never compares owners and never guesses: a session handle is opaque, so only the Runtime
 * can decide whether it belongs to the calling Run.
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

export interface RuntimeProcessOperationsOptions {
  readonly authorizationResolver?: (input: {
    readonly ownerRunId: RunId;
    readonly environment: import("@caelush/agent").ToolExecutionEnvironment;
    readonly securityContext?: ToolSecurityContext | undefined;
  }) => Promise<AuthorizedRuntimeExecution | undefined> | AuthorizedRuntimeExecution | undefined;
}

export function createRuntimeProcessOperations(
  resolver: RuntimeResolver,
  options: RuntimeProcessOperationsOptions = {},
): ExecOperations & ProcessOperations {
  const authorizationFor = async (input: {
    readonly ownerRunId: RunId;
    readonly environment: import("@caelush/agent").ToolExecutionEnvironment;
    readonly securityContext?: ToolSecurityContext | undefined;
  }): Promise<AuthorizedRuntimeExecution | undefined> =>
    options.authorizationResolver === undefined
      ? createDefaultRuntimeProcessAuthorization(input)
      : await options.authorizationResolver(input);

  return {
    async execute(input) {
      const authorization = await authorizationFor(input);
      const scope = await resolveRuntimeWorkspace(resolver, input.environment, {
        securityContext: input.securityContext,
        processAuthorization: authorization,
      });
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
      const authorization = await authorizationFor(input);
      const scope = await resolveRuntimeWorkspace(resolver, input.environment, {
        securityContext: input.securityContext,
        processAuthorization: authorization,
      });
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

    async terminate(input) {
      const authorization = await authorizationFor(input);
      const scope = await resolveRuntimeWorkspace(resolver, input.environment, {
        securityContext: input.securityContext,
        processAuthorization: authorization,
      });
      const result = await scope.exec.terminate({
        ownerRunId: input.ownerRunId,
        sessionId: input.sessionId,
      });
      return toJsonObject(result);
    },
  };
}
