import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  canonicalizeJcs,
  createDeviceProof,
  OfflineGrantError,
  parseStrictJcsJson,
  verifyOfflineGrant,
} from "../../src/main/offline/grant.js";

const vector = JSON.parse(
  await readFile(new URL("../fixtures/offline-grant-v1.json", import.meta.url), "utf8"),
) as {
  payload: Record<string, unknown>;
  publicKey: string;
  signature: string;
  canonicalUtf8Hex: string;
  sha256: string;
};

function rawPublicKey(encoded: string) {
  return Buffer.from(encoded, "base64url");
}

function makeProof(grantId: string, privateKey: KeyObject) {
  const challenge = Buffer.alloc(32, 9);
  return { challenge, signature: createDeviceProof(privateKey, grantId, challenge) };
}

describe("D2 Offline Grant contract", () => {
  it("matches the D2 Python/Node fixed JCS and Ed25519 signature vector", () => {
    const canonical = canonicalizeJcs(vector.payload);
    expect(Buffer.from(canonical, "utf8").toString("hex")).toBe(vector.canonicalUtf8Hex);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(vector.sha256);

    const cloudPublicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        rawPublicKey(vector.publicKey),
      ]),
      format: "der",
      type: "spki",
    });
    expect(vector.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(cloudPublicKey.asymmetricKeyType).toBe("ed25519");
    expect(
      verify(
        null,
        Buffer.from(canonical, "utf8"),
        cloudPublicKey,
        Buffer.from(vector.signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("verifies an envelope against pinned key, local identity, possession proof, rights, and time", () => {
    const device = generateKeyPairSync("ed25519");
    const proof = makeProof(String(vector.payload.grantId), device.privateKey);
    const now = new Date("2026-01-05T12:00:00.000Z");
    const result = verifyOfflineGrant(
      { envelopeVersion: 1, payload: vector.payload, signature: vector.signature },
      {
        trustedPublicKeys: { "offline-vector-2026": rawPublicKey(vector.publicKey) },
        userId: String(vector.payload.userId),
        deviceId: String(vector.payload.deviceId),
        devicePrivateKey: device.privateKey,
        challenge: proof.challenge,
        proofSignature: proof.signature,
        allowedEntitlements: new Set(["CAELUSH_DESKTOP_BASIC"]),
        clock: {
          wallTime: now,
          lastTrustedServerTime: now,
          lastAcceptedTime: now,
        },
      },
    );
    expect(result.entitlements).toEqual(["CAELUSH_DESKTOP_BASIC"]);
    expect(result.nextLastAcceptedTime.toISOString()).toBe(now.toISOString());
  });

  it("rejects a duplicate decoded key and unsupported numeric representation", () => {
    expect(() => parseStrictJcsJson('{"keyId":"one","\\u006beyId":"two"}')).toThrow(
      OfflineGrantError,
    );
    expect(() => parseStrictJcsJson('{"value":-0}')).toThrow(OfflineGrantError);
    expect(() => parseStrictJcsJson('{"value":1.0}')).toThrow(OfflineGrantError);
  });

  it("rejects a different account, device, proof key, trusted key ID, or expired clock", () => {
    const device = generateKeyPairSync("ed25519");
    const proof = makeProof(String(vector.payload.grantId), device.privateKey);
    const envelope = { envelopeVersion: 1, payload: vector.payload, signature: vector.signature };
    const options = {
      trustedPublicKeys: { "offline-vector-2026": rawPublicKey(vector.publicKey) },
      userId: String(vector.payload.userId),
      deviceId: String(vector.payload.deviceId),
      devicePrivateKey: device.privateKey,
      challenge: proof.challenge,
      proofSignature: proof.signature,
      allowedEntitlements: new Set(["CAELUSH_DESKTOP_BASIC"]),
      clock: {
        wallTime: new Date("2026-01-05T12:00:00.000Z"),
        lastTrustedServerTime: new Date("2026-01-05T12:00:00.000Z"),
        lastAcceptedTime: new Date("2026-01-05T12:00:00.000Z"),
      },
    };
    expect(() => verifyOfflineGrant(envelope, { ...options, userId: "other-user" })).toThrow(
      OfflineGrantError,
    );
    expect(() => verifyOfflineGrant(envelope, { ...options, deviceId: "other-device" })).toThrow(
      OfflineGrantError,
    );
    expect(() =>
      verifyOfflineGrant(envelope, { ...options, proofSignature: "A".repeat(86) }),
    ).toThrow(OfflineGrantError);
    expect(() => verifyOfflineGrant(envelope, { ...options, trustedPublicKeys: {} })).toThrow(
      OfflineGrantError,
    );
    expect(() =>
      verifyOfflineGrant(envelope, {
        ...options,
        clock: {
          wallTime: new Date("2026-01-01T11:54:00.000Z"),
          lastTrustedServerTime: new Date("2026-01-01T12:00:00.000Z"),
          lastAcceptedTime: new Date("2026-01-01T12:00:00.000Z"),
        },
      }),
    ).toThrow(OfflineGrantError);
  });

  it("enforces the 15-day maximum, expiry, signed key ID, and strict signed payload fields", () => {
    const signer = generateKeyPairSync("ed25519");
    const device = generateKeyPairSync("ed25519");
    const signerDer = signer.publicKey.export({ format: "der", type: "spki" });
    const signerRaw = Buffer.from(signerDer).subarray(-32);
    const userId = "11111111-1111-4111-8111-111111111111";
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const grantId = "33333333-3333-4333-8333-333333333333";
    const challenge = Buffer.alloc(32, 7);
    const basePayload = {
      schemaVersion: 1,
      grantId,
      userId,
      deviceId,
      issuedAt: "2026-01-01T12:00:00Z",
      expiresAt: "2026-01-16T12:00:00Z",
      entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
      keyId: "local-test-key",
    };
    const envelopeFor = (payload: Record<string, unknown>) => ({
      envelopeVersion: 1,
      payload,
      signature: sign(null, Buffer.from(canonicalizeJcs(payload)), signer.privateKey).toString(
        "base64url",
      ),
    });
    const options = {
      trustedPublicKeys: { "local-test-key": signerRaw },
      userId,
      deviceId,
      devicePrivateKey: device.privateKey,
      challenge,
      proofSignature: createDeviceProof(device.privateKey, grantId, challenge),
      allowedEntitlements: new Set(["CAELUSH_DESKTOP_BASIC"]),
      clock: {
        wallTime: new Date("2026-01-05T12:00:00Z"),
        lastTrustedServerTime: new Date("2026-01-05T12:00:00Z"),
        lastAcceptedTime: new Date("2026-01-05T12:00:00Z"),
      },
    };

    expect(() =>
      verifyOfflineGrant(
        envelopeFor({ ...basePayload, expiresAt: "2026-01-16T12:00:00.001Z" }),
        options,
      ),
    ).toThrow(expect.objectContaining({ code: "GRANT_LIFETIME_INVALID" }));
    expect(() =>
      verifyOfflineGrant(
        envelopeFor({ ...basePayload, expiresAt: "2026-01-04T12:00:00Z" }),
        options,
      ),
    ).toThrow(expect.objectContaining({ code: "GRANT_EXPIRED" }));
    expect(() =>
      verifyOfflineGrant(envelopeFor({ ...basePayload, keyId: "different-key" }), options),
    ).toThrow(expect.objectContaining({ code: "KEY_UNTRUSTED" }));
    expect(() =>
      verifyOfflineGrant(envelopeFor({ ...basePayload, unexpected: true }), options),
    ).toThrow(expect.objectContaining({ code: "PAYLOAD_INVALID" }));
    expect(() =>
      verifyOfflineGrant(envelopeFor(basePayload), { ...options, proofSignature: "A".repeat(86) }),
    ).toThrow(expect.objectContaining({ code: "DEVICE_PROOF_INVALID" }));
  });
});
