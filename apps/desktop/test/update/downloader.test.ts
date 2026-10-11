import { beforeAll, afterAll, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  createLocalUpdateIdentity,
  startLocalUpdateFixture,
} from "../../scripts/local-update-fixture.mjs";
import { downloadInstaller, isPublicAddress } from "../../src/main/update/downloader.js";
import { UpdateStateStore } from "../../src/main/update/state-store.js";
import { verifyPolicyResponse } from "../../src/main/cloud/update-policy.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
let root: string;
let fixture: Awaited<ReturnType<typeof startLocalUpdateFixture>>;
let trust: import("../../src/main/cloud/update-policy.js").UpdateTrust;
let store: UpdateStateStore;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "caelush-d72-https-"));
  const identity = await createLocalUpdateIdentity(root);
  const artifact = path.join(root, "source.exe");
  await fs.writeFile(artifact, Buffer.alloc(32768, 42));
  fixture = await startLocalUpdateFixture(identity, artifact);
  trust = {
    channel: "dev",
    publicKeys: { [identity.keyId]: identity.publicKey },
    allowedReleaseHosts: ["localhost"],
    internalTestCa: identity.ca,
    internalTestLoopback: true,
  };
  store = new UpdateStateStore(path.join(root, "stage"), {
    secureDirectory: async () => {},
    verifyDirectory: async () => {},
    secureFile: async () => {},
    verifyFile: async () => {},
  });
  await store.initialize();
});
afterAll(async () => {
  await fixture?.close();
  await fs.rm(root, { recursive: true, force: true });
});
function policy(overrides: Record<string, unknown> = {}) {
  return verifyPolicyResponse(JSON.stringify(fixture.policy(overrides)), trust, "0.1.0");
}
it("streams HTTPS bytes, calculates exact SHA-512 and publishes only a verified installer", async () => {
  const p = policy();
  const progress: number[] = [];
  const name = await downloadInstaller(p, store, trust, new AbortController().signal, (n) =>
    progress.push(n),
  );
  expect(progress.at(-1)).toBe(32768);
  expect(
    createHash("sha512")
      .update(await fs.readFile(store.file(name)))
      .digest("hex"),
  ).toBe(p.payload.release.sha512);
});
it("rejects truncated, wrong hash / size, redirect and timeout without publishing EXEs", async () => {
  const before = (await fs.readdir(store.root)).filter((n) => n.endsWith(".exe"));
  for (const mode of ["truncated", "redirect", "timeout"]) {
    fixture.setMode(mode);
    await expect(
      downloadInstaller(policy(), store, trust, new AbortController().signal, () => {}, {
        requestMs: 100,
        totalMs: 200,
        redirects: 1,
      }),
    ).rejects.toThrow();
  }
  fixture.setMode("good");
  const base = policy().payload.release;
  for (const release of [
    { ...base, sha512: "0".repeat(128) },
    { ...base, artifactSize: base.artifactSize - 1 },
    { ...base, artifactSize: base.artifactSize + 1 },
  ]) {
    await expect(
      downloadInstaller(policy({ release }), store, trust, new AbortController().signal, () => {}),
    ).rejects.toThrow();
  }
  expect((await fs.readdir(store.root)).filter((n) => n.endsWith(".exe"))).toEqual(before);
  expect((await fs.readdir(store.root)).some((n) => n.endsWith(".part"))).toBe(false);
});
it("cancels an active download and refuses insufficient disk space", async () => {
  fixture.setMode("slow");
  const abort = new AbortController();
  const promise = downloadInstaller(policy(), store, trust, abort.signal, () => {});
  setTimeout(() => abort.abort(), 150);
  await expect(promise).rejects.toThrow();
  fixture.setMode("good");
  vi.mocked(fs.statfs).mockResolvedValueOnce({ bavail: 0, bsize: 1 } as never);
  await expect(
    downloadInstaller(policy(), store, trust, new AbortController().signal, () => {}),
  ).rejects.toThrow("space");
});
it("rejects private and special DNS targets", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ])
    expect(isPublicAddress(ip)).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
});
