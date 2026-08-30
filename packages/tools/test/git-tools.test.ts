import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
  type JsonObject,
} from "@caelush/protocol";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import { createGitToolRegistrations } from "../src/index.js";

const git = promisify(execFile);

describe("Git built-in tools", () => {
  it("dispatches read-only status and diff against a real repository", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-git-tools-"));
    try {
      await mkdir(path.join(parent, "workspace"), { recursive: true });
      await git("git", ["init", "-q"], { cwd: parent });
      await git("git", ["config", "user.email", "test@example.com"], { cwd: parent });
      await git("git", ["config", "user.name", "Caelush Test"], { cwd: parent });
      await writeFile(path.join(parent, "workspace", "tracked.txt"), "before\n", "utf8");
      await git("git", ["add", "workspace/tracked.txt"], { cwd: parent });
      await git("git", ["commit", "-qm", "initial"], { cwd: parent });
      await writeFile(path.join(parent, "workspace", "tracked.txt"), "after\n", "utf8");
      const resolver = createLocalRuntimeResolver(new LocalRuntime());
      const environment = {
        workspace: { id: createWorkspaceId(), path: path.join(parent, "workspace") },
        runtime: { id: "local", kind: "local" },
      } as const;
      const request = (args: JsonObject) => ({
        runId: createRunId(),
        stepId: createStepId(),
        invocationId: createToolInvocationId(),
        externalCallId: "call",
        args,
        environment,
      });
      const registrations = createGitToolRegistrations(resolver);
      const status = await registrations[0]!.handler.execute(request({}));
      const diff = await registrations[1]!.handler.execute(request({ scope: "WORKTREE" }));
      expect(status).toMatchObject({ isError: false, details: { ok: true, clean: false } });
      expect(diff).toMatchObject({ isError: false, details: { ok: true, scope: "WORKTREE" } });
      expect(diff.content).toContain("-before");
      expect(diff.content).toContain("+after");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
