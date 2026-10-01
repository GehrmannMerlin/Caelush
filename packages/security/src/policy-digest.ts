import {
  computeSecurityPolicyDigest,
  verifySecurityPolicyDigest,
  type RunSecurityPolicySnapshotV1,
  type SecurityPolicyDigestInput,
} from "@caelush/protocol";
import { SecurityPolicyInvariantError } from "./errors.js";

export function computePolicyDigest(input: SecurityPolicyDigestInput): string {
  return computeSecurityPolicyDigest(input);
}

export function verifyPolicyDigest(snapshot: RunSecurityPolicySnapshotV1): void {
  if (!verifySecurityPolicyDigest(snapshot)) {
    throw new SecurityPolicyInvariantError("Security policy digest does not match its contents.");
  }
}
