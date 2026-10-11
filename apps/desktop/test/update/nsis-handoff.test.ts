import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizePolicyJson } from "../../src/shared/signed-update-policy.mjs";
import { handoffVerifiedNsis } from "../../src/main/update/nsis-handoff.js";
import type { PendingUpdateRecord, UpdateStateStore } from "../../src/main/update/state-store.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.write("12345\r\n");
      child.emit("close", 0);
    });
    return child;
  });
});

function fixture(status = "LOCKED_VERIFIED") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1,
    product: "caelush",
    platform: "windows",
    arch: "x64",
    channel: "dev",
    currentVersion: "0.1.0",
    latestVersion: "0.1.1",
    minimumSupportedVersion: "0.1.0",
    mandatory: false,
    graceDeadline: null,
    revision: 1,
    release: {
      version: "0.1.1",
      artifactUrl: "https://releases.example.com/installer.exe",
      artifactSize: 3,
      sha512: createHash("sha512").update("exe").digest("hex"),
      releaseNotes: "Test release",
    },
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    keyId: "d72_test_handoff",
  };
  const transactionId = randomUUID();
  const pending: PendingUpdateRecord = {
    transactionId,
    sourceVersion: "0.1.0",
    targetVersion: "0.1.1",
    step: "HANDOFF_STARTED",
    responseJson: JSON.stringify({
      requestId: randomUUID(),
      signedPolicy: {
        envelopeVersion: 1,
        payload,
        signature: sign(null, Buffer.from(canonicalizePolicyJson(payload)), privateKey).toString(
          "base64url",
        ),
      },
    }),
    installerName: `${randomUUID()}.exe`,
    profileSnapshot: null,
  };
  const state = {
    accepted: () => undefined,
    atomicJson: vi.fn(async () => {}),
    readHandoffAck: vi.fn(async () => ({
      transactionId,
      helperPid: 12345,
      status,
      ...(status === "REJECTED" ? { stage: "HASH", systemCode: 13 } : {}),
    })),
    file: (name: string) => `C:\\controlled-updates\\${name}`,
  };
  return {
    state,
    payload,
    options: {
      store: state as unknown as UpdateStateStore,
      pending,
      trust: {
        publicKeys: {
          [payload.keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
        allowedReleaseHosts: ["releases.example.com"],
        channel: "dev" as const,
      },
      executablePath: "C:\\Caelush\\Caelush.exe",
      userDataDirectory: "C:\\isolated-user-data",
      browserDirectory: null,
      internalTest: false,
      quit: vi.fn(),
    },
  };
}

it.skipIf(process.platform !== "win32")(
  "starts a hidden independent Windows helper and authorizes GO only after its protected acknowledgement",
  async () => {
    const f = fixture();
    await handoffVerifiedNsis(f.options);
    const [, args, options] = mocks.spawn.mock.calls[0]!;
    expect(options.detached).not.toBe(true);
    const bootstrap = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(bootstrap).toContain("Start-Process");
    expect(bootstrap).toContain("-WindowStyle Hidden");
    expect(f.state.atomicJson.mock.calls[0]![1]).toMatchObject({
      expiresAtUnixMs: Date.parse(f.payload.expiresAt),
      silent: false,
    });
    expect(f.state.readHandoffAck).toHaveBeenCalledWith(f.options.pending.transactionId);
    expect(f.state.atomicJson).toHaveBeenLastCalledWith(`${f.options.pending.transactionId}.go`, {
      transactionId: f.options.pending.transactionId,
    });
    expect(f.options.quit).toHaveBeenCalledOnce();
  },
);

it.skipIf(process.platform !== "win32")(
  "never authorizes installation after helper rejection",
  async () => {
    const f = fixture("REJECTED");
    await expect(handoffVerifiedNsis(f.options)).rejects.toMatchObject({
      code: "UPDATE_HANDOFF_HASH",
    });
    expect(f.state.atomicJson).toHaveBeenCalledTimes(1);
    expect(f.options.quit).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects another transaction's acknowledgement",
  async () => {
    const f = fixture();
    f.state.readHandoffAck.mockResolvedValue({
      transactionId: randomUUID(),
      helperPid: 12345,
      status: "LOCKED_VERIFIED",
    });
    await expect(handoffVerifiedNsis(f.options)).rejects.toMatchObject({
      code: "UPDATE_HANDOFF_FAILED",
    });
    expect(f.options.quit).not.toHaveBeenCalled();
  },
);
