import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostReplayKeyProvider,
  createWindowsReplayKeyProvider,
} from "../src/replay/replay-key-provider.js";
import { createInjectedReplayKeyProvider } from "@caelush/security";
import { randomBytes } from "node:crypto";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("host ReplayKeyProvider", () => {
  it("fails closed on a host without DPAPI or explicit secret injection", async () => {
    const provider = createHostReplayKeyProvider({ platform: "linux", keyFile: "unused" });
    await expect(provider.current()).rejects.toThrow("Private replay unavailable.");
    expect(await provider.get("missing")).toBeUndefined();
  });

  it("accepts an explicit persistent secret provider on non-Windows hosts", async () => {
    const key = randomBytes(32);
    const injected = createInjectedReplayKeyProvider("host-secret-v1", key);
    const provider = createHostReplayKeyProvider({
      platform: "linux",
      keyFile: "unused",
      injected,
    });
    const restored = await provider.get("host-secret-v1");
    expect(restored?.keyId === "host-secret-v1" && Buffer.from(restored.bytes).equals(key)).toBe(
      true,
    );
    key.fill(0);
    restored?.bytes.fill(0);
  });

  it.runIf(process.platform === "win32")(
    "protects a persistent key with real CurrentUser DPAPI and recovers in a fresh provider",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "caelush-dpapi-"));
      directories.push(dir);
      const keyFile = join(dir, "keys", "replay-key.json");
      const first = createWindowsReplayKeyProvider(keyFile);
      const key = await first.current();
      const disk = await readFile(keyFile);
      expect(disk.includes(Buffer.from(key.bytes))).toBe(false);
      expect(disk.toString().includes(Buffer.from(key.bytes).toString("base64"))).toBe(false);
      const reopened = createWindowsReplayKeyProvider(keyFile);
      const restored = await reopened.get(key.keyId);
      expect(Buffer.from(restored!.bytes).equals(Buffer.from(key.bytes))).toBe(true);
      expect(await reopened.get("another-key")).toBeUndefined();
      const envelope = JSON.parse(disk.toString());
      envelope.keyId = "changed-identity";
      await writeFile(keyFile, JSON.stringify(envelope));
      await expect(createWindowsReplayKeyProvider(keyFile).get("changed-identity")).rejects.toThrow(
        /^Private replay unavailable\.$/,
      );
      key.bytes.fill(0);
      restored!.bytes.fill(0);
    },
    20000,
  );

  it.runIf(process.platform === "win32")(
    "publishes one durable key under concurrent initialization and refuses corrupt files",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "caelush-dpapi-race-"));
      directories.push(dir);
      const keyFile = join(dir, "key.json");
      const [a, b] = await Promise.all([
        createWindowsReplayKeyProvider(keyFile).current(),
        createWindowsReplayKeyProvider(keyFile).current(),
      ]);
      expect(a.keyId).toBe(b.keyId);
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
      await writeFile(keyFile, "invalid");
      await expect(createWindowsReplayKeyProvider(keyFile).current()).rejects.toThrow(
        /^Private replay unavailable\.$/,
      );
      a.bytes.fill(0);
      b.bytes.fill(0);
    },
    20000,
  );
});
