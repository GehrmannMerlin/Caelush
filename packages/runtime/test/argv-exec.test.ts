import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { LocalRuntime, RuntimeBoundaryError } from "../src/index.js";

describe("LocalRuntime typed argv execution", () => {
  it("executes an explicit argv without shell composition", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-argv-exec-"));
    const runtime = new LocalRuntime({
      processManagerOptions: { generationId: "argv-generation" },
    });
    try {
      const scope = await runtime.openWorkspace({ id: createWorkspaceId(), path: parent });
      const result = await scope.exec.executeArgv({
        ownerRunId: "run_argv" as never,
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "argv-safe"],
        workdir: ".",
        yieldTimeMs: 5000,
      });
      expect(result).toMatchObject({ status: "EXITED", exitCode: 0, output: "argv-safe" });
    } finally {
      await runtime.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects unsafe or oversized argv before process creation", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-argv-validation-"));
    const runtime = new LocalRuntime();
    try {
      const scope = await runtime.openWorkspace({ id: createWorkspaceId(), path: parent });
      const base = { ownerRunId: "run_argv_validation" as never, yieldTimeMs: 5000 };
      await expect(
        scope.exec.executeArgv({ ...base, executable: "", args: [] }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGV",
      });
      await expect(
        scope.exec.executeArgv({ ...base, executable: "node\u0000", args: [] }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGV",
      });
      await expect(
        scope.exec.executeArgv({ ...base, executable: "node", args: [""] }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGV",
      });
      await expect(
        scope.exec.executeArgv({ ...base, executable: "node", args: ["a".repeat(16 * 1024 + 1)] }),
      ).rejects.toMatchObject({ code: "INVALID_ARGV" });
      await expect(
        scope.exec.executeArgv({
          ...base,
          executable: "node",
          args: Array.from({ length: 129 }, () => "a"),
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGV" });
      await expect(
        scope.exec.executeArgv({ ...base, executable: "node", args: ["a".repeat(64 * 1024)] }),
      ).rejects.toMatchObject({ code: "INVALID_ARGV" });
      await expect(
        scope.exec.executeArgv({ ...base, executable: "node", args: [], workdir: "../outside" }),
      ).rejects.toBeInstanceOf(RuntimeBoundaryError);
    } finally {
      await runtime.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
