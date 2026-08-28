import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { LocalContextFileSystem } from "../src/filesystem.js";
import { LocalEnvironmentDetector } from "../src/environment.js";
import { WorkspaceScopeResolver } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("captures only the allowlisted local environment facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-context-environment-"));
  temporaryDirectories.push(root);
  const scope = await new WorkspaceScopeResolver(new LocalContextFileSystem()).resolve({
    id: createWorkspaceId(),
    path: root,
  });

  const snapshot = new LocalEnvironmentDetector().detect(scope, root);

  expect(snapshot).toEqual({
    platform: process.platform,
    arch: process.arch,
    hostNodeVersion: process.version,
    pathStyle: process.platform === "win32" ? "WINDOWS" : "POSIX",
    workspaceRoot: scope.realRoot,
    projectRoot: root,
    cwd: scope.realCwd,
  });
  expect(JSON.stringify(snapshot)).not.toMatch(
    /PATH|HOME|USERPROFILE|AWS_|OPENAI_|TOKEN|SHELL|ComSpec/,
  );
});
