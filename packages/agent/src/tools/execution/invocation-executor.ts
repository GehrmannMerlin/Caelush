import type { ToolInvocation } from "@caelush/protocol";

import type { PreparedToolCall } from "../call/tool-call-preparer.js";
import type { AgentToolResult } from "../types/tool-result.js";
import type { ToolExecutionEnvironment } from "../types/execution-environment.js";
import type { ToolExecutionIdentity } from "../types/execution-identity.js";
import { ToolExecutionInfrastructureError } from "../types/errors.js";
import type { ToolExecutionUpdate, ToolExecutionUpdateSink } from "../types/tool-update.js";
import {
  isToolExecutionUncertainError,
  ToolExecutionUncertainError,
} from "./execution-disposition.js";
import {
  DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER,
  type TransientToolUpdateConsumer,
  type TransientToolUpdateDiagnostics,
  type ToolExecutionUpdateSanitizerPort,
} from "./update-sanitizer-port.js";

/**
 * Execute one already-prepared, already-durably-started Tool invocation.
 *
 * ```ts
 * export interface ToolInvocationExecutor {
 *   execute(input: {
 *     readonly call: PreparedToolCall;
 *     readonly identity: ToolExecutionIdentity;
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly signal: AbortSignal;
 *   }): Promise<AgentToolResult>;
 * }
 * ```
 *
 * ## The hard invariant this contract sits behind
 *
 * ```text
 * ToolInvocation -> RUNNING
 * durable commit succeeds
 * ToolInvocationExecutor.execute()
 * AgentTool.execute()
 * ```
 *
 * The executor executes what the durable shell has already committed. It **never** creates an
 * invocation, never transitions one, and never writes storage: if it did, "the side effect happened
 * while the durable state was still unknown" would become reachable, and recovery could no longer
 * tell whether a repeat was safe.
 *
 * ## What the executor owns
 *
 * ```text
 * building AgentToolExecutionInput from the caller's identity, args, environment and signal
 * the safe transient update sink, its sanitization and its ordered delivery
 * the acceptingUpdates lifetime and the drain of everything already accepted
 * classifying an execution throw as uncertain versus infrastructure
 * ```
 *
 * ## What it deliberately does not own
 *
 * ```text
 * preparation, resolution, argument validation     admission, approval, budget
 * REQUESTED or RUNNING transitions                 observations, durable events, settlement
 * batch scheduling                                 model feedback, Run status, completion
 * ```
 *
 * Nothing of that appears in the input type, and nothing of it can be reached from here.
 */
export interface ToolInvocationExecutor {
  execute(input: {
    readonly call: PreparedToolCall;
    readonly identity: ToolExecutionIdentity;
    readonly environment: ToolExecutionEnvironment;
    readonly signal: AbortSignal;
  }): Promise<AgentToolResult>;
}

/** How to bind an executor to the invocation whose updates it will sanitize and publish. */
export interface ToolInvocationExecutorOptions {
  /**
   * The durable invocation this executor executes for.
   *
   * The frozen `ToolInvocationExecutor` input deliberately carries `ToolExecutionIdentity` rather
   * than a `ToolInvocation`, because a general executor has no business reading durable rows. The
   * update sanitizer port, however, needs the invocation: redaction depends on the Tool's identity
   * and, for a path-based Tool, on its arguments. Binding the invocation here is what keeps both true
   * without widening the frozen interface or letting `@caelush/agent` reach storage.
   */
  readonly invocation: ToolInvocation;
  readonly updateSanitizer?: ToolExecutionUpdateSanitizerPort | undefined;
  readonly transientUpdates?: TransientToolUpdateConsumer | undefined;
  readonly diagnostics?: TransientToolUpdateDiagnostics | undefined;
}

/**
 * Build an invocation-bound executor.
 *
 * The returned object satisfies the frozen `ToolInvocationExecutor` contract exactly; the binding is
 * an implementation seam, not part of the public shape.
 */
export function createToolInvocationExecutor(
  options: ToolInvocationExecutorOptions,
): ToolInvocationExecutor {
  const invocation = options.invocation;
  const updateSanitizer = options.updateSanitizer;
  const transientUpdates = options.transientUpdates ?? DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER;
  const diagnostics = options.diagnostics;

  return {
    async execute(input): Promise<AgentToolResult> {
      assertIdentityMatchesInvocation(input.identity, invocation);

      const updater = createUpdatePipeline({
        invocation,
        ...(updateSanitizer === undefined ? {} : { updateSanitizer }),
        transientUpdates,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      });

      try {
        // The canonical AgentTool is the one execution authority. A legacy `ToolHandler` is reached
        // only through the adapter that built this AgentTool, never from here.
        const result = await input.call.resolved.tool.execute({
          identity: input.identity,
          args: input.call.args,
          environment: input.environment,
          signal: input.signal,
          updates: updater.sink,
        });
        updater.close();
        await updater.drain();
        return result;
      } catch (error) {
        updater.close();
        await updater.drain();
        throw classifyExecutionFailure(error);
      }
    },
  };
}

/**
 * The identity the caller supplies must be the identity of the invocation being executed.
 *
 * A mismatch means the pipeline has lost track of which call it is running, and running a Tool under
 * a foreign identity would attribute a side effect to the wrong invocation. It fails closed before
 * any Tool code runs.
 */
function assertIdentityMatchesInvocation(
  identity: ToolExecutionIdentity,
  invocation: ToolInvocation,
): void {
  if (
    identity.invocationId !== invocation.id ||
    identity.runId !== invocation.runId ||
    identity.sourceStepId !== invocation.stepId ||
    identity.externalCallId !== (invocation.externalCallId ?? identity.externalCallId)
  ) {
    throw new ToolExecutionInfrastructureError(
      "EXECUTION",
      "Tool execution identity does not match the bound Tool invocation.",
    );
  }
}

interface UpdatePipeline {
  readonly sink: ToolExecutionUpdateSink;
  /** Stop accepting updates. Called the moment the Tool's promise settles. */
  close(): void;
  /** Resolve once every already-accepted update has been sanitized and delivered. */
  drain(): Promise<void>;
}

/**
 * The safe transient update pipeline behind `ToolExecutionUpdateSink`.
 *
 * ```text
 * publish(raw)
 *   │  acceptingUpdates === false -> drop silently (orphan)
 *   ▼
 * sanitize(raw)
 *   │  null      -> drop            (sanitizer rejected it)
 *   │  throws    -> drop + report   (never forward the raw update)
 *   ▼
 * enqueue ordered delivery
 * ```
 *
 * `publish` is synchronous by contract, so a Tool never waits for a consumer. Delivery is serialized
 * through one promise chain per invocation, which is what makes the accepted order the observed order
 * without making the Tool's `publish` async.
 */
function createUpdatePipeline(input: {
  readonly invocation: ToolInvocation;
  readonly updateSanitizer?: ToolExecutionUpdateSanitizerPort;
  readonly transientUpdates: TransientToolUpdateConsumer;
  readonly diagnostics?: TransientToolUpdateDiagnostics;
}): UpdatePipeline {
  let acceptingUpdates = true;
  let chain: Promise<void> = Promise.resolve();

  const report = (callback: () => void): void => {
    try {
      callback();
    } catch {
      // Diagnostics are strictly best effort and must never alter execution semantics.
    }
  };

  const dropped = (
    reason: "ORPHAN" | "SANITIZER_REJECTED" | "SANITIZER_FAILED",
    cause?: unknown,
  ): void => {
    report(() =>
      input.diagnostics?.onUpdateDropped({
        toolName: input.invocation.toolName,
        invocationId: input.invocation.id,
        reason,
        ...(cause === undefined ? {} : { cause }),
      }),
    );
  };

  return {
    sink: Object.freeze({
      publish(update: ToolExecutionUpdate): void {
        if (!acceptingUpdates) {
          dropped("ORPHAN");
          return;
        }

        const sanitizer = input.updateSanitizer;
        if (sanitizer === undefined) {
          // Without a sanitizer there is no safe way to forward an update, and forwarding the raw
          // one is exactly the fallback this path forbids.
          dropped("SANITIZER_REJECTED");
          return;
        }

        let sanitized: ToolExecutionUpdate | null;
        let sanitizedMany: readonly ToolExecutionUpdate[] | undefined;
        try {
          const sanitizerInput = {
            toolName: input.invocation.toolName,
            invocation: input.invocation,
            update,
          };
          if (sanitizer.sanitizeMany !== undefined) {
            sanitizedMany = sanitizer.sanitizeMany(sanitizerInput);
            sanitized = null;
          } else {
            sanitized = sanitizer.sanitize(sanitizerInput);
          }
        } catch (error) {
          dropped("SANITIZER_FAILED", error);
          return;
        }
        const deliveries =
          sanitizedMany === undefined ? (sanitized === null ? [] : [sanitized]) : sanitizedMany;
        if (deliveries.length === 0) {
          dropped("SANITIZER_REJECTED");
          return;
        }

        for (const delivery of deliveries) {
          chain = chain
            .then(async () => {
              await input.transientUpdates.publish({
                toolName: input.invocation.toolName,
                invocation: input.invocation,
                update: delivery,
              });
            })
            .catch((error: unknown) => {
              // A transient consumer failure is observational. It cannot change the Tool result and it
              // cannot break the ordering chain for the updates that follow.
              report(() =>
                input.diagnostics?.onDeliveryFailed({
                  toolName: input.invocation.toolName,
                  invocationId: input.invocation.id,
                  cause: error,
                }),
              );
            });
        }
      },
    }),
    close(): void {
      acceptingUpdates = false;
    },
    async drain(): Promise<void> {
      await chain;
    },
  };
}

/**
 * Classify an execution throw.
 *
 * ```text
 * canonical uncertain error    rethrown unchanged, so the durable shell records UNCERTAIN_SIDE_EFFECT
 * a legacy uncertain error     mapped onto the canonical class, same disposition, message kept
 * anything else                ToolExecutionInfrastructureError, phase EXECUTION, sanitized message
 * ```
 *
 * An unknown throw is never turned into `isError: true`: a model that read "the tool failed" would
 * retry a call whose real outcome is unknown, and the raw error text may carry host paths, secrets or
 * provider internals that must not reach model history.
 */
function classifyExecutionFailure(error: unknown): Error {
  if (error instanceof ToolExecutionUncertainError) return error;
  if (isToolExecutionUncertainError(error)) {
    return new ToolExecutionUncertainError(
      error instanceof Error && error.message.length > 0
        ? error.message
        : "Tool execution side effects could not be verified safely.",
    );
  }
  return new ToolExecutionInfrastructureError(
    "EXECUTION",
    "Tool execution failed because the Tool implementation threw an unexpected error.",
    { cause: error },
  );
}
