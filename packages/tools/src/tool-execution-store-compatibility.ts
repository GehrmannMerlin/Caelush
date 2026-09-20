import type { AgentState, TimestampMs } from "@caelush/protocol";
import {
  type ToolExecutionCommit,
  type ToolExecutionCommitResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
  type ToolSettlementExtension,
} from "@caelush/agent";

import { decodeLegacyToolEffects } from "./settlement-extension-bridge.js";

/**
 * The legacy store contract, as the pre-4C shell declared it.
 *
 * It is the canonical `ToolExecutionStorePort` widened only in the argument type of `commit`, which
 * additionally accepts the two Coding effects facets. A store written against this shape keeps
 * compiling; the canonical coordinator writes the `extension` facet instead.
 */
export interface LegacyToolExecutionStorePort extends Omit<ToolExecutionStorePort, "commit"> {
  commit(command: LegacyToolExecutionCommit): Promise<ToolExecutionCommitResult>;
}

/** The canonical commit plus the legacy effects facets a pre-4C store accepts. */
export interface LegacyToolExecutionCommit extends ToolExecutionCommit {
  readonly effects?: readonly import("./tool-effects.js").ToolEffect[] | undefined;
  readonly effectTimestamp?: TimestampMs | undefined;
}

/**
 * Adapt the canonical durable Tool store onto the legacy store contract.
 *
 * ```text
 * canonical coordinator
 *   └── commit({ …, extension: ToolSettlementExtension })        the only durable path in 4C
 *         └── this adapter
 *               └── commit({ …, effects: ToolEffect[] })          the pre-4C shape
 *                     └── the existing implementation
 * ```
 *
 * ## Why the shell needs it, and for how long
 *
 * A pre-4C `ToolExecutionStorePort` implementation — and, more importantly, the pre-4C **test doubles**
 * that assert the store contract — accept `effects`/`effectTimestamp` rather than `extension`. The
 * adapter is what lets the canonical coordinator be the single durable writer without rewriting every
 * one of those at once.
 *
 * It is pure and synchronous, and it keeps the atomicity argument intact: the decoded `ToolEffect[]`
 * travels in the *same* single `commit` call as the invocation, the observation and the events, so
 * nothing about the transaction changes. Nothing here can split it in two.
 *
 * A composition whose store already implements the canonical port passes it directly and this adapter
 * is not used at all; the production daemon does exactly that.
 */
export function toLegacyToolExecutionStore(
  store: ToolExecutionStorePort,
): LegacyToolExecutionStorePort {
  return {
    load: (invocationId) => store.load(invocationId),
    findByExternalCall: (runId, stepId, externalCallId) =>
      store.findByExternalCall(runId, stepId, externalCallId),
    async commit(command: LegacyToolExecutionCommit): Promise<ToolExecutionCommitResult> {
      return await store.commit(toCanonicalCommit(command));
    },
  };
}

/**
 * Strip the legacy effects facets and carry them as the opaque settlement extension instead.
 *
 * The canonical coordinator already speaks `extension`; a pre-4C caller speaks `effects`. This is the
 * one translation between the two, and it is pure: the same effects, in the same single commit, under
 * the kind the storage compatibility boundary decodes.
 */
export function toCanonicalCommit(command: LegacyToolExecutionCommit): ToolExecutionCommit {
  const { effects, effectTimestamp, ...canonical } = command;
  const extension = canonical.extension ?? projectLegacyEffectsExtension(effects, effectTimestamp);
  return { ...canonical, ...(extension === undefined ? {} : { extension }) };
}

function projectLegacyEffectsExtension(
  effects: readonly import("./tool-effects.js").ToolEffect[] | undefined,
  effectTimestamp: TimestampMs | undefined,
): ToolSettlementExtension | undefined {
  void effectTimestamp;
  if (effects === undefined || effects.length === 0) return undefined;
  return Object.freeze({
    kind: "caelush.coding.effects.v1",
    payload: Object.freeze({ effects: effects as unknown as never }),
  });
}

/**
 * The host-side decoder for the production storage compatibility boundary.
 *
 * ```text
 * ToolSettlementExtension { kind: "caelush.coding.effects.v1", payload: { effects } }
 *        ↓ decode, exactly once
 * ToolEffect[]
 *        ↓
 * AgentState projection  (effectsChangeAgentState / applyToolEffectsToAgentState)
 * ```
 *
 * `@caelush/storage` takes this as a constructor dependency rather than importing it, because the
 * Coding effect vocabulary lives here and storage may not depend on the legacy Tool System. The result
 * is the same projection the pre-4C shell performed, applied inside the same SQLite transaction.
 *
 * The host supplies its own two projection functions, so this bridge never has to be duplicated for a
 * host whose effect model is its own.
 */
export function createLegacyToolSettlementExtensionDecoder(input: {
  readonly effects: {
    readonly changesState: (effects: readonly unknown[]) => boolean;
    readonly apply: (
      state: AgentState,
      effects: readonly unknown[],
      now: TimestampMs,
    ) => AgentState;
  };
}): {
  decode(extension: ToolSettlementExtension): {
    readonly changeState: boolean;
    readonly apply: (state: AgentState, now: TimestampMs) => AgentState;
  };
} {
  return {
    decode(extension: ToolSettlementExtension) {
      const effects = decodeLegacyToolEffects(extension);
      if (effects === undefined) {
        throw new LegacySettlementExtensionError();
      }
      const frozen = Object.freeze([...effects]);
      return {
        changeState: input.effects.changesState(frozen),
        apply: (state: AgentState, now: TimestampMs): AgentState =>
          input.effects.apply(state, frozen, now),
      };
    },
  };
}

/** A settlement extension this host's Coding overlay did not declare. */
export class LegacySettlementExtensionError extends Error {
  constructor() {
    super("Tool settlement carried an unknown settlement extension.");
    this.name = "LegacySettlementExtensionError";
  }
}

export type { ToolExecutionSnapshot };
