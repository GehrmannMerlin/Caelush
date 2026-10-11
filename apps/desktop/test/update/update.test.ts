import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalizePolicyJson } from "../../src/shared/signed-update-policy.mjs";
import { DesktopUpdateCoordinator } from "../../src/main/update/coordinator.js";
import { UpdateStateStore } from "../../src/main/update/state-store.js";
import { UpdatePolicyClient, verifyPolicyResponse } from "../../src/main/cloud/update-policy.js";
import { validateReleaseUrl } from "../../src/main/update/downloader.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trust = {
  publicKeys: { d72_test_unit: publicKey.export({ format: "pem", type: "spki" }).toString() },
  allowedReleaseHosts: ["releases.example.com"],
  channel: "dev" as const,
};
function response(overrides: Record<string, unknown> = {}) {
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
    keyId: "d72_test_unit",
    ...overrides,
  };
  return JSON.stringify({
    requestId: "c1c57727-06d1-41d8-b854-4feee46ae250",
    signedPolicy: {
      envelopeVersion: 1,
      payload,
      signature: sign(null, Buffer.from(canonicalizePolicyJson(payload)), privateKey).toString(
        "base64url",
      ),
    },
  });
}
const permissions = {
  secureDirectory: async () => {},
  verifyDirectory: async () => {},
  secureFile: async () => {},
  verifyFile: async () => {},
};
const roots: string[] = [];
async function store() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-d72-"));
  roots.push(root);
  return new UpdateStateStore(root, permissions);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("signed Cloud update response", () => {
  it("verifies the real transport wrapper and exact request identity", () => {
    expect(verifyPolicyResponse(response(), trust, "0.1.0").payload.latestVersion).toBe("0.1.1");
    expect(() => verifyPolicyResponse(response({ channel: "beta" }), trust, "0.1.0")).toThrow();
    expect(() =>
      verifyPolicyResponse(response({ currentVersion: "0.0.9" }), trust, "0.1.0"),
    ).toThrow();
  });
  it("rejects duplicate keys, tampering, unknown keys and expiration", () => {
    for (const raw of [
      response().replace('"envelopeVersion":1', '"envelopeVersion":1,"envelopeVersion":1'),
      response().replace("Test release", "Tampered"),
      response({ keyId: "unknown" }),
      response({ issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-02T00:00:00Z" }),
    ]) {
      expect(() => verifyPolicyResponse(raw, trust, "0.1.0")).toThrow();
    }
  });
  it("distinguishes no policy from proof of current version", async () => {
    const client = new UpdatePolicyClient("http://127.0.0.1:1", trust, "0.1.0", async () => ({
      status: 404,
      body: "",
    }));
    expect(await client.check()).toBeNull();
  });
});
describe("application revision and crash state", () => {
  it("isolates revision ranges by channel and keeps the state envelope order-independent", async () => {
    const state = await store();
    await state.initialize();
    await state.accept(verifyPolicyResponse(response({ revision: 3 }), trust, "0.1.0"));
    const beta = verifyPolicyResponse(
      response({ revision: 1, channel: "beta" }),
      { ...trust, channel: "beta" },
      "0.1.0",
    );
    await state.accept(beta);
    const restarted = new UpdateStateStore(state.root, permissions);
    await restarted.initialize();
    expect(restarted.accepted("dev")?.revision).toBe(3);
    expect(restarted.accepted("beta")?.revision).toBe(1);
  });
  it("persists revisions across restart and rejects rollback / equivocation", async () => {
    const state = await store();
    await state.initialize();
    const first = verifyPolicyResponse(response({ revision: 2 }), trust, "0.1.0");
    await state.accept(first);
    const restarted = new UpdateStateStore(state.root, permissions);
    await restarted.initialize();
    expect(restarted.accepted("dev")?.revision).toBe(2);
    await expect(
      restarted.accept(verifyPolicyResponse(response(), trust, "0.1.0")),
    ).rejects.toThrow();
    await expect(
      restarted.accept(
        verifyPolicyResponse(response({ revision: 2, mandatory: true }), trust, "0.1.0"),
      ),
    ).rejects.toThrow();
    await restarted.accept(first);
  });
  it("fails closed on corrupted security state instead of resetting revision", async () => {
    const state = await store();
    await state.initialize();
    await state.accept(verifyPolicyResponse(response(), trust, "0.1.0"));
    await writeFile(path.join(state.root, "state.json"), "{broken");
    await expect(new UpdateStateStore(state.root, permissions).initialize()).rejects.toThrow();
  });
  it("cleans interrupted streams and unpublished installers without resetting revision", async () => {
    const state = await store();
    await state.initialize();
    await state.accept(verifyPolicyResponse(response({ revision: 8 }), trust, "0.1.0"));
    for (const suffix of ["part", "tmp", "exe"])
      await writeFile(path.join(state.root, `${randomUUID()}.${suffix}`), "incomplete");
    await writeFile(path.join(state.root, "unrelated.txt"), "retained");
    const restarted = new UpdateStateStore(state.root, permissions);
    await restarted.initialize();
    expect(restarted.accepted("dev")?.revision).toBe(8);
    expect((await readdir(state.root)).sort()).toEqual(["state.json", "unrelated.txt"]);
    expect(restarted.pending()).toBeNull();
  });
});
describe("Main coordinator authority", () => {
  async function fixture(
    shutdown = async () => {},
    extra: Partial<ConstructorParameters<typeof DesktopUpdateCoordinator>[0]> = {},
  ) {
    const state = await store();
    const raw = response();
    const policy = verifyPolicyResponse(raw, trust, "0.1.0");
    const check = vi.fn(async () => ({ ...policy, responseJson: raw }));
    const handoff = vi.fn(async () => {});
    const coordinator = new DesktopUpdateCoordinator({
      version: "0.1.0",
      trust,
      store: state,
      client: { check },
      download: async (_policy, signal, onProgress) => {
        if (signal.aborted) throw new Error("cancelled");
        const name = "00000000-0000-4000-8000-000000000000.exe";
        await writeFile(path.join(state.root, name), "exe");
        onProgress(3);
        return name;
      },
      safeShutdown: shutdown,
      confirmInstall: async () => true,
      handoff,
      verifyRuntime: async () => {},
      captureProfile: async () => null,
      verifyProfile: async () => {},
      resume: async () => {},
      ...extra,
    });
    await coordinator.initialize();
    return { coordinator, check, handoff, state };
  }
  it("coalesces checks/download/install and never installs before verification", async () => {
    const f = await fixture();
    await f.coordinator.install();
    expect(f.handoff).not.toHaveBeenCalled();
    await Promise.all([f.coordinator.check(), f.coordinator.check()]);
    expect(f.check).toHaveBeenCalledTimes(1);
    await Promise.all([f.coordinator.download(), f.coordinator.download()]);
    expect(f.coordinator.getState().status).toBe("READY_TO_INSTALL");
    await Promise.all([f.coordinator.install(), f.coordinator.install()]);
    expect(f.handoff).toHaveBeenCalledTimes(1);
  });
  it("coalesces deferral and prevents installation racing a resumed Daemon", async () => {
    let release!: () => void;
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resume = vi.fn(() => resumed);
    const f = await fixture(async () => {}, { resume });
    await f.coordinator.check();
    await f.coordinator.download();
    const first = f.coordinator.deferInstall();
    const second = f.coordinator.deferInstall();
    await Promise.resolve();
    await f.coordinator.install();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(f.handoff).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(f.coordinator.getState().status).toBe("INSTALL_DEFERRED");
  });
  it("waits for a safe checkpoint without launching an installer", async () => {
    const f = await fixture(async () => {
      throw Object.assign(new Error("pending"), { failureKind: "SAFE_CHECKPOINT_PENDING" });
    });
    await f.coordinator.check();
    await f.coordinator.download();
    await f.coordinator.install();
    expect(f.coordinator.getState().status).toBe("WAITING_FOR_SAFE_SHUTDOWN");
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it("gives each confirmed handoff a fresh authorization identity after a launch failure", async () => {
    const f = await fixture();
    f.handoff.mockRejectedValue(new Error("handoff launch failed"));
    await f.coordinator.check();
    await f.coordinator.download();
    await f.coordinator.install();
    await f.coordinator.install();
    expect(f.handoff).toHaveBeenCalledTimes(2);
    expect(f.handoff.mock.calls[0]![0].transactionId).not.toBe(
      f.handoff.mock.calls[1]![0].transactionId,
    );
  });
  it("retains the verified installer when the user cancels native installation confirmation", async () => {
    const safeShutdown = vi.fn(async () => {});
    const f = await fixture(safeShutdown, { confirmInstall: async () => false });
    await f.coordinator.check();
    await f.coordinator.download();
    await f.coordinator.install();
    expect(f.coordinator.getState().status).toBe("INSTALL_DEFERRED");
    expect(f.state.pending()?.step).toBe("READY");
    expect(safeShutdown).not.toHaveBeenCalled();
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it("re-verifies staged bytes immediately before shutdown / handoff", async () => {
    const f = await fixture();
    await f.coordinator.check();
    await f.coordinator.download();
    const exe = (await readdir(f.state.root)).find((n) => n.endsWith(".exe"))!;
    await writeFile(path.join(f.state.root, exe), "bad");
    await f.coordinator.install();
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.coordinator.getState().status).toBe("ERROR");
  });
  it("recovers READY after a pre-handoff crash without automatically launching", async () => {
    const f = await fixture();
    await f.coordinator.check();
    await f.coordinator.download();
    await f.coordinator.initialize();
    expect(f.coordinator.getState().status).toBe("READY_TO_INSTALL");
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it("refuses an interrupted handoff without a confirmed installer receipt", async () => {
    const f = await fixture();
    await f.coordinator.check();
    await f.coordinator.download();
    await f.state.setPending({ ...f.state.pending()!, step: "HANDOFF_STARTED" });
    await f.coordinator.initialize();
    expect(f.coordinator.getState().status).toBe("ERROR");
    expect(f.coordinator.getState().errorCode).toBe("UPDATE_INSTALL_UNCONFIRMED");
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it("requires a real new runtime before marking installer exit as complete", async () => {
    const f = await fixture();
    await f.coordinator.check();
    await f.coordinator.download();
    const pending = f.state.pending()!;
    await f.state.setPending({ ...pending, step: "HANDOFF_STARTED" });
    await f.state.atomicJson(`${pending.transactionId}.receipt.json`, {
      transactionId: pending.transactionId,
      status: "INSTALLER_EXITED",
      exitCode: 0,
      installerPid: 100,
    });
    await f.coordinator.initialize();
    expect(f.coordinator.getState().status).toBe("ERROR");
    expect(f.state.pending()?.step).not.toBe("COMPLETED");
  });
  it.each(["FAILED", "CANCELLED"] as const)(
    "preserves a failed or cancelled installer receipt (%s)",
    async (status) => {
      const f = await fixture();
      await f.coordinator.check();
      await f.coordinator.download();
      const pending = f.state.pending()!;
      await f.state.setPending({ ...pending, step: "HANDOFF_STARTED" });
      await f.state.atomicJson(`${pending.transactionId}.receipt.json`, {
        transactionId: pending.transactionId,
        status,
        exitCode: status === "CANCELLED" ? 1 : 2,
        installerPid: 100,
      });
      await f.coordinator.initialize();
      expect(f.coordinator.getState().status).toBe("ERROR");
      expect(f.handoff).not.toHaveBeenCalled();
    },
  );
  it("rejects a damaged pending record on restart without touching accepted revision", async () => {
    const f = await fixture();
    await f.coordinator.check();
    await f.coordinator.download();
    await writeFile(
      path.join(f.state.root, "state.json"),
      JSON.stringify({
        data: { pending: { step: "READY", installerName: "outside.exe" } },
        sha256: "0".repeat(64),
      }),
    );
    const restarted = new UpdateStateStore(f.state.root, permissions);
    await expect(restarted.initialize()).rejects.toThrow();
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it("does not reuse an expired policy as installation authority for completed history", async () => {
    const f = await fixture();
    await f.coordinator.check();
    await f.coordinator.download();
    const pending = f.state.pending()!;
    await f.state.setPending({
      ...pending,
      step: "COMPLETED",
      responseJson: response({
        issuedAt: "2020-01-01T00:00:00Z",
        expiresAt: "2020-01-02T00:00:00Z",
      }),
    });
    await f.coordinator.initialize();
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.coordinator.getState().status).not.toBe("ERROR");
  });
  it("resumes first-start runtime verification after its committed Profile boundary", async () => {
    const f = await fixture();
    await f.coordinator.check();
    await f.coordinator.download();
    const pending = f.state.pending()!;
    await f.state.setPending({ ...pending, step: "HANDOFF_STARTED" });
    await f.state.atomicJson(`${pending.transactionId}.receipt.json`, {
      transactionId: pending.transactionId,
      status: "INSTALLER_EXITED",
      exitCode: 0,
      installerPid: 100,
    });
    const verifyProfile = vi.fn(async () => {});
    const verifyRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error("interrupted first startup"))
      .mockResolvedValue(undefined);
    const recovery = await fixture(async () => {}, {
      store: f.state,
      version: "0.1.1",
      verifyProfile,
      verifyRuntime,
    });
    expect(recovery.coordinator.getState().status).toBe("ERROR");
    expect(f.state.pending()?.step).toBe("POST_INSTALL_PROFILE_VERIFIED");
    await recovery.coordinator.initialize();
    expect(recovery.coordinator.getState().status).toBe("COMPLETED");
    expect(verifyProfile).toHaveBeenCalledTimes(1);
    expect(verifyRuntime).toHaveBeenCalledTimes(2);
  });
});
describe("release origin authority", () => {
  it("rejects non HTTPS, credentials, fragments, untrusted hosts and IP literals", () => {
    for (const url of [
      "http://releases.example.com/a",
      "https://user@releases.example.com/a",
      "https://releases.example.com/a#f",
      "https://evil.example/a",
      "https://127.0.0.1/a",
    ]) {
      expect(() => validateReleaseUrl(url, trust)).toThrow();
    }
    expect(validateReleaseUrl("https://releases.example.com/a", trust).hostname).toBe(
      "releases.example.com",
    );
  });
});
