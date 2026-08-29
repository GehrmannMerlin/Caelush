import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalRuntime, RuntimeBoundaryError, RuntimePathTypeError } from "../src/index.js";
import { createWorkspaceId } from "@caelush/protocol";

describe("LocalRuntime exec service", () => {
  it("validates workspace-relative workdirs and keeps yield separate from timeout", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-exec-service-"));
    let runtime: LocalRuntime | undefined;
    try {
      const workspace = path.join(parent, "workspace");
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "file.txt"), "file", "utf8");
      runtime = new LocalRuntime({ processManagerOptions: { generationId: "service-generation" } });
      const scope = await runtime.openWorkspace({
        id: createWorkspaceId(),
        path: workspace,
      });
      await expect(
        scope.exec.execute({
          ownerRunId: "run_a" as never,
          command: "pwd",
          tty: false,
          yieldTimeMs: 5000,
          workdir: "src",
        }),
      ).resolves.toMatchObject({ status: "EXITED", exitCode: 0 });
      await expect(
        scope.exec.execute({
          ownerRunId: "run_a" as never,
          command: "pwd",
          tty: false,
          yieldTimeMs: 5000,
          workdir: "file.txt",
        }),
      ).rejects.toBeInstanceOf(RuntimePathTypeError);
      await expect(
        scope.exec.execute({
          ownerRunId: "run_a" as never,
          command: "pwd",
          tty: false,
          yieldTimeMs: 5000,
          workdir: "../outside",
        }),
      ).rejects.toBeInstanceOf(RuntimeBoundaryError);
    } finally {
      // The runtime owns child-process handles even after a quick exit is observed.
      await runtime?.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
