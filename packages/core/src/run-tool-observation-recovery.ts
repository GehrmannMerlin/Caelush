import type { RunId, StepId } from "@caelush/protocol";
import type { ToolExecutionStorePort } from "@caelush/agent";

/**
 * Where a Tool's raw output pointer is resolved from, durably.
 *
 * ```text
 * model sees a bounded summary        observed through the Tool observation projection
 * the raw output lives in the Tool layer
 *        ↓
 * a later forced Context recovery re-reads it under a tighter policy
 * ```
 *
 * `rawArtifactRef` is a durable artifact-linkage pointer rather than model-visible content, and the
 * frozen canonical Tool-result contract deliberately has no field for it. That is exactly why the
 * pointer cannot travel inside an Agent message: the frozen boundary is general, and a general host
 * has no artifact store.
 *
 * The Tool Layer already persists it — a `ToolObservation` row carries `rawArtifactRef`, and the
 * execution store indexes it by the durable Tool call identity — so this port is a *lookup* over
 * data the Run already wrote, not a second storage authority and not a new table. The legacy
 * Context adapter resolves each Tool result through it when it needs the unbounded output again.
 */
export interface ToolRawObservationRefResolver {
  /**
   * The raw artifact pointer one Tool call produced, or `undefined` when there is none.
   *
   * An `undefined` answer is a real answer and not a failure. An external caller may supply a Tool
   * result for a call this Run never dispatched, and a Tool that produced no artifact simply has
   * none; both are legitimate, and both leave the Context fallback to the bounded `content` the
   * message already carries.
   */
  resolve(input: {
    readonly runId: RunId;
    readonly sourceStepId: StepId;
    readonly externalCallId: string;
  }): Promise<string | undefined>;
}

/**
 * Resolve raw observation pointers from the durable Tool execution ledger.
 *
 * The ledger is the provenance authority for a raw Tool output: the invocation row is keyed by
 * `(runId, stepId, externalCallId)` — the same identity the Tool turn was executed under — and its
 * settled observation carries the artifact pointer the Tool store wrote in the same transaction as
 * the result. Reading it back is therefore a restart-safe lookup rather than a reconstruction, and
 * it needs no migration, no second table and no copy of the pointer in the Run's own rows.
 */
export function createToolExecutionLedgerRawObservationResolver(dependencies: {
  /**
   * The durable Tool execution ledger.
   *
   * It is the Tool Layer's own store port — not a Core-private copy of its shape — so the lookup
   * cannot drift from the rows it reads.
   */
  readonly store: Pick<ToolExecutionStorePort, "findByExternalCall">;
}): ToolRawObservationRefResolver {
  return {
    async resolve({ runId, sourceStepId, externalCallId }): Promise<string | undefined> {
      const snapshot = await dependencies.store.findByExternalCall(
        runId,
        sourceStepId,
        externalCallId,
      );
      return snapshot?.observation?.rawArtifactRef;
    },
  };
}
