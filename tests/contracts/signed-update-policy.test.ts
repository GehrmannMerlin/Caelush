import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  canonicalizePolicyJson,
  parsePolicyJson,
  PolicyContractError,
  validateUpdatePolicyPayload,
  verifySignedUpdatePolicy,
} from "../../scripts/contracts/signed-update-policy.mjs";

const fixtures = new URL("./fixtures/", import.meta.url);
const vector = JSON.parse(
  await readFile(new URL("canonical-policy-v1.json", fixtures), "utf8"),
) as {
  envelope: {
    envelopeVersion: number;
    payload: Record<string, unknown>;
    signature: string;
  };
  testOnlyPublicKeys: Record<string, string>;
  testOnlyAllowedReleaseHosts: string[];
  testOnlyVerificationTime: string;
};
const expected = JSON.parse(
  await readFile(new URL("canonical-policy-v1.expected.json", fixtures), "utf8"),
) as {
  canonicalUtf8Hex: string;
  sha256: string;
  signature: string;
  keyId: string;
};

function verify(envelope = vector.envelope, overrides: Record<string, unknown> = {}) {
  return verifySignedUpdatePolicy(JSON.stringify(envelope), {
    publicKeys: vector.testOnlyPublicKeys,
    allowedReleaseHosts: vector.testOnlyAllowedReleaseHosts,
    now: Date.parse(vector.testOnlyVerificationTime),
    ...overrides,
  });
}

function expectPolicyError(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("Expected a policy contract error.");
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyContractError);
    expect((error as PolicyContractError).code).toBe(code);
  }
}

describe("signed update policy contract", () => {
  it("matches the fixed JCS UTF-8, SHA-256, and Ed25519 vector", () => {
    const canonical = canonicalizePolicyJson(vector.envelope.payload);
    const bytes = Buffer.from(canonical, "utf8");
    expect(bytes.toString("hex")).toBe(expected.canonicalUtf8Hex);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
    expect(vector.envelope.signature).toBe(expected.signature);
    expect(vector.envelope.payload.keyId).toBe(expected.keyId);
    expect(verify().digestSha256).toBe(expected.sha256);
  });

  it("canonicalizes property order while preserving Unicode and escape semantics", () => {
    expect(canonicalizePolicyJson({ z: 1, a: { y: true, x: null } })).toBe(
      canonicalizePolicyJson({ a: { x: null, y: true }, z: 1 }),
    );
    expect(canonicalizePolicyJson({ text: 'é\n"\\' })).toBe('{"text":"é\\n\\\"\\\\"}');
    expect(canonicalizePolicyJson({ text: "é" })).not.toBe(
      canonicalizePolicyJson({ text: "e\u0301" }),
    );
    expect(canonicalizePolicyJson({ revision: 1 })).not.toBe(
      canonicalizePolicyJson({ revision: 2 }),
    );
  });

  it.each(["1.0", "1e0", "-0", "9007199254740992", "1e400"])(
    "rejects non-contract numeric form %s",
    (text) => expectPolicyError(() => parsePolicyJson(text), "POLICY_NUMBER_UNSUPPORTED"),
  );

  it("rejects duplicate decoded keys, invalid Unicode, and trailing JSON", () => {
    expectPolicyError(
      () => parsePolicyJson('{"keyId":"one","\\u006beyId":"two"}'),
      "POLICY_JSON_DUPLICATE_KEY",
    );
    expectPolicyError(() => parsePolicyJson('{"value":"\\ud800"}'), "POLICY_UNICODE_INVALID");
    expectPolicyError(() => parsePolicyJson('{"valid":true} trailing'), "POLICY_JSON_INVALID");
  });

  it("requires exact signed payload fields and a present keyId", () => {
    const { keyId: _keyId, ...withoutKeyId } = vector.envelope.payload;
    expectPolicyError(() => validateUpdatePolicyPayload(withoutKeyId), "POLICY_PAYLOAD_INVALID");
  });

  it("rejects invalid signatures, unknown key IDs, and allowlist misses", () => {
    const tampered = structuredClone(vector.envelope);
    (tampered.payload.release as Record<string, unknown>).releaseNotes = "Changed after signing";
    expectPolicyError(() => verify(tampered), "POLICY_SIGNATURE_INVALID");

    const wrongKey = structuredClone(vector.envelope);
    wrongKey.payload.keyId = "untrusted-key";
    expectPolicyError(() => verify(wrongKey), "POLICY_KEY_ID_UNKNOWN");

    expectPolicyError(
      () => verify(vector.envelope, { allowedReleaseHosts: ["updates.example.test"] }),
      "POLICY_ARTIFACT_HOST_NOT_ALLOWED",
    );
  });

  it("rejects policies outside their signed validity window", () => {
    expectPolicyError(
      () => verify(vector.envelope, { now: Date.parse("2026-10-08T23:59:59Z") }),
      "POLICY_NOT_YET_VALID",
    );
    expectPolicyError(
      () => verify(vector.envelope, { now: Date.parse("2026-11-09T00:00:00Z") }),
      "POLICY_EXPIRED",
    );
  });

  it("rejects revision rollback and same-revision content changes", () => {
    expectPolicyError(
      () =>
        verify(vector.envelope, { acceptedPolicy: { revision: 8, digestSha256: "a".repeat(64) } }),
      "POLICY_REVISION_ROLLBACK",
    );
    expectPolicyError(
      () =>
        verify(vector.envelope, { acceptedPolicy: { revision: 7, digestSha256: "b".repeat(64) } }),
      "POLICY_REVISION_CONFLICT",
    );
    expect(
      verify(vector.envelope, { acceptedPolicy: { revision: 7, digestSha256: expected.sha256 } })
        .digestSha256,
    ).toBe(expected.sha256);
  });

  it("enforces SemVer/channel, version-range, and artifact integrity fields", () => {
    const invalidSemVer = structuredClone(vector.envelope.payload);
    invalidSemVer.latestVersion = "1.01.0";
    expectPolicyError(() => validateUpdatePolicyPayload(invalidSemVer), "POLICY_VERSION_INVALID");

    const stablePrerelease = structuredClone(vector.envelope.payload);
    stablePrerelease.latestVersion = "1.1.0-beta.1";
    expectPolicyError(
      () => validateUpdatePolicyPayload(stablePrerelease),
      "POLICY_CHANNEL_VERSION_MISMATCH",
    );

    const invalidMinimum = structuredClone(vector.envelope.payload);
    invalidMinimum.minimumSupportedVersion = "1.2.0";
    expectPolicyError(
      () => validateUpdatePolicyPayload(invalidMinimum),
      "POLICY_VERSION_RANGE_INVALID",
    );

    const wrongArtifactVersion = structuredClone(vector.envelope.payload);
    (wrongArtifactVersion.release as Record<string, unknown>).version = "1.0.9";
    expectPolicyError(
      () => validateUpdatePolicyPayload(wrongArtifactVersion),
      "POLICY_RELEASE_VERSION_MISMATCH",
    );
  });
});
