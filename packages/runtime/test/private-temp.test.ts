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
});
