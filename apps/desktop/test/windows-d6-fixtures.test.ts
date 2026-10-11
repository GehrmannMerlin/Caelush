import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  D6_TEST_EMAIL,
  D6_TEST_PASSWORD,
  startInternalCloudFixture,
} from "../scripts/windows-d6-fixtures.mjs";
import { CloudAccountClient } from "../src/main/cloud/client.js";
import { createDeviceProof, verifyOfflineGrant } from "../src/main/offline/grant.js";

describe("D6 internal Cloud fixture with the production account client", () => {
  let root: string;
  let fixture: Awaited<ReturnType<typeof startInternalCloudFixture>>;
  let cloud: CloudAccountClient;
  let cloudKeys: { publicKey: KeyObject; privateKey: KeyObject };
  const keyId = "d6_fixture_contract";
  const deviceKeys = generateKeyPairSync("ed25519");
  const loginInput = {
    email: D6_TEST_EMAIL,
    password: D6_TEST_PASSWORD,
    device: {
      label: "D6 contract test",
      publicKey: deviceKeys.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64url"),
    },
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "caelush-d6-cloud-contract-"));
    cloudKeys = generateKeyPairSync("ed25519");
    const privateKeyPath = path.join(root, `fixture-${randomUUID()}.pem`);
    await writeFile(privateKeyPath, cloudKeys.privateKey.export({ type: "pkcs8", format: "pem" }));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (address === null || typeof address === "string") throw new Error("No fixture port.");
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    fixture = await startInternalCloudFixture({ cloudPort: address.port, privateKeyPath, keyId });
    cloud = new CloudAccountClient(fixture.origin);
  });

  afterEach(async () => {
    await fixture?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("serves the frozen v1 login, signed Grant, refresh, and logout contracts", async () => {
    const auth = await cloud.login(loginInput, new AbortController().signal);
    expect(auth.offlineGrant).not.toBeNull();
    const challenge = Buffer.alloc(32, 7);
    const now = new Date();
    const grant = verifyOfflineGrant(auth.offlineGrant, {
      trustedPublicKeys: {
        [keyId]: cloudKeys.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
      },
      userId: auth.account.userId,
      deviceId: auth.device.deviceId,
      devicePrivateKey: deviceKeys.privateKey,
      challenge,
      proofSignature: createDeviceProof(
        deviceKeys.privateKey,
        auth.offlineGrant!.payload.grantId,
        challenge,
      ),
      allowedEntitlements: new Set(["CAELUSH_DESKTOP_BASIC"]),
      clock: { wallTime: now, lastTrustedServerTime: now, lastAcceptedTime: now },
    });
    expect(grant.entitlements).toEqual(["CAELUSH_DESKTOP_BASIC"]);
    const refreshed = await cloud.refresh(auth.tokens.refreshToken, new AbortController().signal);
    expect(refreshed.account.userId).toBe(auth.account.userId);
    expect(
      await cloud.logout(refreshed.tokens.accessToken, new AbortController().signal),
    ).toMatchObject({ status: "SUCCEEDED" });
    await expect(
      cloud.refresh(refreshed.tokens.refreshToken, new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID", statusCode: 401 });
  });

  it("returns a valid frozen error envelope when test login credentials are rejected", async () => {
    await expect(
      cloud.login({ ...loginInput, password: "incorrect" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS", statusCode: 401 });
  });
});
