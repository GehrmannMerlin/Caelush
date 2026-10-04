import type { ModelRef } from "@caelush/protocol";
import type { RetryErrorCode } from "./agent-continuation.js";

export type { ModelTransportRecoveryCheckpoint } from "@caelush/agent";

/** A provider/model identity paired with one configured transport candidate. */
export interface ModelTransportSelection {
  readonly transportId: string;
  readonly providerId: ModelRef["provider"];
  readonly modelId: ModelRef["model"];
}

/**
 * Host-owned mapping from one immutable Provider binding to equivalent transport candidates.
 * Core owns when a candidate may be selected; the host port owns which configured candidates
 * are equivalent and whether a different rate-limit domain permits rate-limit recovery.
 */
export interface ModelTransportRecoveryPort {
  initial(input: {
    readonly providerId: ModelRef["provider"];
    readonly modelId: ModelRef["model"];
  }): ModelTransportSelection;
  next(input: {
    readonly current: ModelTransportSelection;
    readonly attemptedTransportIds: readonly string[];
    readonly errorCode: RetryErrorCode;
  }): ModelTransportSelection | undefined;
}
