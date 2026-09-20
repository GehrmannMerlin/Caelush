import type {
  AgentError,
  JsonObject,
  ObservationId,
  TimestampMs,
  ToolInvocation,
  ToolObservation,
} from "@caelush/protocol";

import { ToolExecutionInfrastructureError } from "../types/errors.js";
import type { ToolPresentationPort } from "../types/tool-presentation.js";
import type { AgentToolResult } from "../types/tool-result.js";
import type { PreparedToolSettlement } from "../result/result-pipeline.js";
import type { ToolSettlementExtension } from "../result/result-policy.js";
import {
  completeToolInvocation,
  failToolInvocation,
  isTerminalToolInvocation,
} from "./invocation-lifecycle.js";
import { assertToolObservationInvariant, createToolObservation } from "./observation.js";
import {
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolOutputEvent,
} from "./durable-events.js";
import type {
  DurableToolEventDraft,
  ToolExecutionSnapshot,
  ToolExecutionStorePort,
} from "./execution-store-port.js";
import { ToolExecutionConflictError, ToolExecutionInvariantError } from "./durable-errors.js";

/**
 * The terminal settlement boundary.
 *
 * ```ts
 * export interface ToolSettlementCoordinator {
 *   settle(input: {
 *     readonly snapshot: ToolExecutionSnapshot;
 *     readonly settlement: PreparedToolSettlement;
 *     readonly now: TimestampMs;
 *   }): Promise<ToolExecutionSnapshot>;
 * }
 * ```
 *
 * ## What it owns
 *
 * ```text
 * ① result.isError ? FAILED : COMPLETED
 * ② the ToolObservation for that outcome
 * ③ the terminal durable event
 * ④ the opaque settlement extension, passed through unchanged
 * ⑤ one atomic ToolExecutionStorePort.commit
 * ⑥ budget settlement, coordinated with that commit
 * ⑦ the committed snapshot
 * ```
 *
 * ## What it never owns
 *
 * ```text
 * models, model feedback, batches
 * Run status, verification, completion
 * Tool argument validation
 * security policy
 * Tool execution
 * ```
 *
 * ## Inputs that are injected, not added to the frozen signature
 *
 * The frozen `settle` input is exactly three fields, and it stays that way. Three things the
 * implementation nonetheless needs are bound at construction time instead:
 *
 * ```text
 * the observation and event id factories          constructor dependencies
 * the raw artifact reference                      an invocation-bound resolver
 * the presentation port                            the host's optional safe projection
 * ```
 *
 * That is an implementation seam, not a contract expansion. A caller passes the snapshot and the
 * settlement it has; it never passes an identity factory, a storage handle or a workspace. The
 * `rawArtifactRef` resolver in particular is how the production archive — written before the result
 * pipeline bounded the output — still reaches the durable observation without the Agent layer learning
 * that an artifact store exists.
 */
export interface ToolSettlementCoordinator {
  settle(input: {
    readonly snapshot: ToolExecutionSnapshot;
    readonly settlement: PreparedToolSettlement;
    readonly now: TimestampMs;
  }): Promise<ToolExecutionSnapshot>;
}

/** Everything settlement is built from. */
export interface ToolSettlementCoordinatorOptions {
  readonly store: ToolExecutionStorePort;
  readonly clock: { now(): TimestampMs };
  readonly observationIdFactory: { create(): ObservationId };
  readonly eventIdFactory: { create(): import("@caelush/protocol").EventId };
  /** Optional safe, presentation-only projection. It never participates in the outcome. */
  readonly presentation?: ToolPresentationPort | undefined;
  /**
   * The archived, complete pre-projection Tool output for this invocation.
   *
   * Injected per invocation because the frozen `settle` input has no field for it and the general
   * settlement layer must not learn that an archive exists. A resolver that throws fails settlement:
   * the archive was written after the side effect may already have happened, so losing it silently
   * would leave durable state that cannot be reconciled with the workspace.
   */
  readonly rawArtifactRef?: (() => Promise<string | undefined>) | undefined;
  /**
   * Budget settlement, called after the terminal commit succeeds.
   *
   * The terminal commit moves the matching ledger entry atomically on the production SQLite path, so
   * this is a second, **idempotent** statement of the same fact — it lets a non-atomic host
   * implementation settle too. It is not the authority, and it never runs before the durable truth.
   */
  readonly budget?:
    | {
        settle(input: {
          readonly runId: import("@caelush/protocol").RunId;
          readonly invocationId: import("@caelush/protocol").ToolInvocationId;
          readonly status: import("@caelush/protocol").ToolInvocationStatus;
          readonly finishedAt: TimestampMs;
        }): Promise<void>;
      }
    | undefined;
  readonly notifier?: { notifyCommitted(events: readonly unknown[]): void } | undefined;
}

export function createToolSettlementCoordinator(
  options: ToolSettlementCoordinatorOptions,
): ToolSettlementCoordinator {
  return {
    async settle(input): Promise<ToolExecutionSnapshot> {
      const { snapshot, settlement, now } = input;
      const invocation = snapshot.invocation;
      assertSettleable(invocation);

      const result = settlement.result;
      const terminal = result.isError
        ? failToolInvocation(
            invocation,
            {
              code: "TOOL_EXECUTION_ERROR",
              message: "Tool execution returned an error result.",
              retryable: false,
              phase: "TOOL",
            },
            now,
          )
        : completeToolInvocation(invocation, now);

      const rawArtifactRef = await resolveRawArtifactRef(options, terminal);
      const observation = createToolObservation({
        id: options.observationIdFactory.create(),
        runId: terminal.runId,
        stepId: terminal.stepId,
        toolInvocationId: terminal.id,
        content: result.content,
        // The result layer speaks the AI package's JSON model; the durable observation speaks the
        // Protocol one. They describe the same JSON value and differ only in declaration, so this is
        // the single point where the two vocabularies meet.
        details: result.details as unknown as JsonObject,
        isError: result.isError,
        ...(rawArtifactRef === undefined ? {} : { rawArtifactRef }),
        createdAt: now,
      });
      assertToolObservationInvariant(observation, terminal);

      const committed = await commitTerminal(options, {
        snapshot,
        terminal,
        observation,
        result,
        extension: settlement.effects,
        now,
      });

      if (committed.snapshot.observation === undefined) {
        throw new ToolExecutionInvariantError("Tool settlement committed without an observation.");
      }

      // Budget settlement is a second statement of a fact the terminal commit already owns on the
      // production path. It runs after the durable truth exists, never before, so a crash between the
      // two can only leave the ledger *behind* durable Tool truth — which recovery resolves — and
      // never ahead of it.
      try {
        await options.budget?.settle({
          runId: terminal.runId,
          invocationId: terminal.id,
          status: terminal.status,
          finishedAt: now,
        });
      } catch (error) {
        throw new ToolExecutionInfrastructureError("SETTLEMENT", "Tool budget settlement failed.", {
          cause: error,
        });
      }

      return committed.snapshot;
    },
  };
}

/**
 * Refuse to settle anything that is not a durably started, still-running invocation.
 *
 * Settlement is the *second* half of a lifecycle whose first half is a committed `RUNNING` row. A
 * snapshot that is already terminal was settled by someone else, and settling it again would create a
 * second observation and a second terminal event for one execution.
 */
function assertSettleable(invocation: ToolInvocation): void {
  if (invocation.status === "RUNNING") return;
  if (isTerminalToolInvocation(invocation)) {
    throw new ToolExecutionInvariantError("Tool settlement requires a RUNNING invocation.");
  }
  throw new ToolExecutionInvariantError(
    "Tool settlement requires an invocation that already reached RUNNING.",
  );
}

async function resolveRawArtifactRef(
  options: ToolSettlementCoordinatorOptions,
  invocation: ToolInvocation,
): Promise<string | undefined> {
  if (options.rawArtifactRef === undefined) return undefined;
  try {
    return await options.rawArtifactRef();
  } catch (error) {
    // The archive happens after the Tool may already have had its side effect. Losing it silently and
    // recording COMPLETED would leave durable state that disagrees with the workspace, so the
    // invocation stays RUNNING for uncertain recovery instead.
    throw new ToolExecutionInfrastructureError(
      "SETTLEMENT",
      `Tool raw output archive failed for invocation ${invocation.id}.`,
      { cause: error },
    );
  }
}

async function commitTerminal(
  options: ToolSettlementCoordinatorOptions,
  input: {
    readonly snapshot: ToolExecutionSnapshot;
    readonly terminal: ToolInvocation;
    readonly observation: ToolObservation;
    readonly result: AgentToolResult;
    readonly extension: ToolSettlementExtension | undefined;
    readonly now: TimestampMs;
  },
): Promise<{ readonly snapshot: ToolExecutionSnapshot }> {
  const { snapshot, terminal, observation, result, extension, now } = input;
  const events: DurableToolEventDraft[] = [
    // Whatever durable events the host's settlement extension contributed — a Tool effect projected into
    // a host-domain event — travel in this same commit, ahead of the terminal event, so the chronology
    // of the settlement reads effect-then-outcome.
    ...(extension?.events ?? []),
  ];
  const outputEvent = createToolOutputEvent({
    eventId: options.eventIdFactory.create(),
    sessionId: snapshot.sessionId,
    timestamp: now,
    invocation: terminal,
    presentation: options.presentation,
    result,
  });
  if (outputEvent !== undefined) events.push(outputEvent);
  events.push(
    terminal.status === "FAILED"
      ? createToolFailedEvent({
          eventId: options.eventIdFactory.create(),
          sessionId: snapshot.sessionId,
          timestamp: now,
          invocation: terminal,
          error: terminal.error as AgentError,
          presentation: options.presentation,
          result,
        })
      : createToolCompletedEvent({
          eventId: options.eventIdFactory.create(),
          sessionId: snapshot.sessionId,
          timestamp: now,
          invocation: terminal,
          observationId: observation.id,
          presentation: options.presentation,
          result,
        }),
  );

  let committed;
  try {
    committed = await options.store.commit({
      sessionId: snapshot.sessionId,
      invocation: terminal,
      expectedRevision: snapshot.revision,
      observation,
      events,
      // The extension is forwarded exactly as the result pipeline produced it. This layer never reads
      // its `kind`, never interprets its payload and never imports a Coding effect type.
      ...(extension === undefined ? {} : { extension }),
    });
  } catch (error) {
    if (error instanceof ToolExecutionConflictError) throw error;
    if (error instanceof ToolExecutionInvariantError) throw error;
    throw new ToolExecutionInfrastructureError("SETTLEMENT", "Tool settlement commit failed.", {
      cause: error,
    });
  }
  if (committed.events.length > 0) options.notifier?.notifyCommitted(committed.events);
  return { snapshot: committed.snapshot };
}
