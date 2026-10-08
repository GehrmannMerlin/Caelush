import type { AIProviderOpaqueState } from "@caelush/ai";

/** Private execution contracts. Neither payload bytes nor these ports belong in public events. */
export interface PrivateReplayIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: string;
  readonly replayVersion: 1;
}

export interface EncryptedPrivateReplay {
  readonly version: 1;
  readonly keyId: string;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
  /** Keyed equality check, authenticated as part of the envelope; never a plaintext hash. */
  readonly contentMac: string;
}

export interface PrivateReplayWrite {
  readonly identity: PrivateReplayIdentity;
  readonly envelope: EncryptedPrivateReplay;
}

/** Injected by the host; Storage never receives a key provider or owns key material. */
export interface ReplayProtectionPort {
  seal(identity: PrivateReplayIdentity, content: Uint8Array): Promise<EncryptedPrivateReplay>;
  open(identity: PrivateReplayIdentity, envelope: EncryptedPrivateReplay): Promise<Uint8Array>;
  verify(identity: PrivateReplayIdentity, envelope: EncryptedPrivateReplay): Promise<void>;
}

/** A host capability for exactly the messages selected for one execution. */
export interface PrivateReplayReadScope {
  readonly sessionId: string;
  readonly executionRunId: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: string;
  readonly selectedMessageIds: readonly string[];
  /** Ordered Assistant subset from this same Context selection; binds each opaque reference to its message. */
  readonly selectedAssistantMessageIds?: readonly string[];
}

export interface PrivateReplayReader {
  read(identity: PrivateReplayIdentity): Promise<Uint8Array>;
}

/** No standalone durable write or unscoped plaintext lookup. Commit owns persistence. */
export interface PrivateReplayStorePort {
  prepare(identity: PrivateReplayIdentity, content: Uint8Array): Promise<PrivateReplayWrite>;
  forExecution(scope: PrivateReplayReadScope): PrivateReplayReader;
}

export class PrivateReplayError extends Error {
  constructor() {
    super("Private replay unavailable.");
    this.name = "PrivateReplayError";
  }
}

export const PRIVATE_REPLAY_REFERENCE_KIND = "caelush.private-replay.v1";

/** The existing ProviderState carries only this closed, non-secret reference. */
export function createPrivateReplayReference(
  identity: PrivateReplayIdentity,
): AIProviderOpaqueState {
  assertPrivateReplayIdentity(identity);
  return Object.freeze({
    providerId: identity.providerId,
    api: identity.api,
    version: 1,
    payload: Object.freeze({
      kind: PRIVATE_REPLAY_REFERENCE_KIND,
      replayId: identity.messageId,
      sessionId: identity.sessionId,
      runId: identity.runId,
      callId: identity.callId,
      model: identity.model,
      replayVersion: 1,
    }),
  });
}

export function assertPrivateReplayIdentity(identity: PrivateReplayIdentity): void {
  const keys = [
    "sessionId",
    "runId",
    "messageId",
    "callId",
    "providerId",
    "model",
    "api",
    "replayVersion",
  ];
  if (
    identity === null ||
    typeof identity !== "object" ||
    Object.keys(identity).length !== keys.length ||
    Object.keys(identity).some((key) => !keys.includes(key)) ||
    identity.replayVersion !== 1
  )
    throw new PrivateReplayError();
  for (const key of keys.slice(0, -1)) {
    const value: unknown = identity[key as keyof PrivateReplayIdentity];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 512)
      throw new PrivateReplayError();
  }
}
