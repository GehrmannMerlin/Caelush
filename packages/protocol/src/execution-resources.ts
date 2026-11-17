import type { RunId } from "./primitives/ids.js";

/** A Run-bound immutable resource identity used only inside the host execution pipeline. */
export interface ReadOnlyResourceIdentity {
  readonly resourceId: string;
  readonly bundleRevision: string;
  readonly canonicalRoot: string;
  readonly contentManifestHash: string;
}

/** Current host authority for the exact immutable resources a Run may expose to a process. */
export interface ReadOnlyResourcePolicy {
  readonly runId: RunId;
  readonly revision: string;
  readonly enabled: boolean;
  readonly expiresAt: number;
  readonly resources: readonly ReadOnlyResourceIdentity[];
}

declare const readOnlyResourceGrantBrand: unique symbol;

/** Host-only grant. It is never part of a Protocol DTO, event, transcript, or model message. */
export interface ReadOnlyResourceGrant extends ReadOnlyResourceIdentity {
  readonly runId: RunId;
  readonly policyRevision: string;
  readonly lifetime: {
    readonly issuedAt: number;
    readonly expiresAt: number;
  };
  /** Stable, bounded identity for this resource and policy, used in approvals and runner negotiation. */
  readonly authorityFingerprint: string;
  readonly [readOnlyResourceGrantBrand]: true;
}
