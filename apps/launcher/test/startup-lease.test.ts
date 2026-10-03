import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isStartupLeaseExpired, tryAcquireStartupLease } from "../src/startup-lease.js";

describe("startup lease", () => {
  it("renews a long-running owner heartbeat", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-startup-lease-renew-"));
    const directory = join(root, "lease");
    try {
      const lease = await tryAcquireStartupLease({ directory, version: "0.1.0", now: 1_000 });
      expect(lease).toBeDefined();
      expect(await isStartupLeaseExpired(directory, 16_000, 15_000)).toBe(true);

      expect(await lease!.renew(16_000)).toBe(true);
      expect(await isStartupLeaseExpired(directory, 30_000, 15_000)).toBe(false);
      expect(await isStartupLeaseExpired(directory, 31_000, 15_000)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let an expired owner release a replacement lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-startup-lease-owner-"));
    const directory = join(root, "lease");
    try {
      const first = await tryAcquireStartupLease({ directory, version: "0.1.0", now: 1_000 });
      expect(first).toBeDefined();
      await rm(directory, { recursive: true, force: true });
      const replacement = await tryAcquireStartupLease({
        directory,
        version: "0.1.0",
        now: 20_000,
      });
      expect(replacement).toBeDefined();

      await first!.release();
      expect(await tryAcquireStartupLease({ directory, version: "0.1.0", now: 20_001 })).toBe(
        undefined,
      );
      await replacement!.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
