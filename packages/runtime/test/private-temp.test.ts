import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupPrivateRunTemp,
  cleanupStalePrivateRunTemps,
  createPrivateRunTemp,
} from "../src/index.js";

describe("private Run temp directories", () => {
  it("creates a product-owned marker and cleans only the exact marked directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "caelush-private-temp-test-"));
    try {
      const temp = await createPrivateRunTemp("run_private_temp" as never, { baseDirectory: base });
      expect(await readFile(temp.markerPath, "utf8")).toContain("run_private_temp");
      await writeFile(path.join(temp.root, "output.txt"), "bounded", "utf8");
      await cleanupPrivateRunTemp(temp);
      await expect(access(temp.root)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("removes stale marked directories but leaves unmarked directories untouched", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "caelush-private-temp-stale-"));
    try {
      const stale = await createPrivateRunTemp("run_stale" as never, { baseDirectory: base });
      const unmarked = await mkdtemp(path.join(base, "caelush-run-unmarked-"));
      await cleanupStalePrivateRunTemps({ baseDirectory: base, maxAgeMs: 0 });
      await expect(access(stale.root)).rejects.toThrow();
      await expect(access(unmarked)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses cleanup when the marker belongs to another Run", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "caelush-private-temp-mismatch-"));
    try {
      const temp = await createPrivateRunTemp("run_marker_owner" as never, {
        baseDirectory: base,
      });
      await expect(
        cleanupPrivateRunTemp({ ...temp, markerId: "another-marker" }),
      ).rejects.toMatchObject({ code: "PRIVATE_TEMP_INVALID" });
      await expect(access(temp.root)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  /**
   * SEC-3, from Phase 7 Task 5 Step 6's independent security review.
   *
   * The marker is what makes cleanup safe, and it lives *inside* the directory the sandboxed payload is
   * granted: the Windows Runner applies `FILE_ALL_ACCESS` to this root before the child starts. A
   * payload can therefore delete or corrupt `.caelush-private-temp.json`, after which neither the
   * per-Run cleanup nor the stale sweep reclaims the directory — `assertPrivateTempMarker` cannot verify
   * ownership, and `cleanupStalePrivateRunTemps` skips a directory whose marker it cannot read.
   *
   * The consequence is bounded but real: the directory, and the ACE the per-Run capability SID holds on
   * it, are not reclaimed. The SID is derived from a random per-Run marker id, so this is resource
   * litter rather than a widening of authority. Pinned here so the limitation is visible and cannot
   * silently worsen — for example by a change that deletes an unmarked `caelush-run-*` directory on a
   * name match alone.
   */
  it("refuses both cleanups once the payload has destroyed the ownership marker", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "caelush-private-temp-evasion-"));
    try {
      const temp = await createPrivateRunTemp("run_marker_evasion" as never, {
        baseDirectory: base,
      });
      await rm(temp.markerPath, { force: true });
      await expect(cleanupPrivateRunTemp(temp)).rejects.toMatchObject({
        code: "PRIVATE_TEMP_INVALID",
      });
      await expect(access(temp.root)).resolves.toBeUndefined();
      await cleanupStalePrivateRunTemps({ baseDirectory: base, maxAgeMs: 0 });
      await expect(access(temp.root)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
