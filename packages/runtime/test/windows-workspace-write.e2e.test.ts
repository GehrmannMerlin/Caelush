import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  createNativeWorkspaceSandboxController,
  createRuntimeProcessPolicy,
  createWindowsAclRestrictedTokenProvider,
  type ManagedProcessAdapter,
  type NativeSandboxRunnerManifest,
  type NativeWorkspaceSandboxController,
  type PrivateRunTemp,
  type ProcessExit,
  type SandboxedSpawnSpec,
} from "../src/index.js";
import {
  buildSandboxRunner,
  // @ts-expect-error The release helper is a checked-in JavaScript build script without a declaration file.
} from "../../../scripts/build-sandbox-runner.mjs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const providerId = "windows-acl-restricted-token";

describeWindows("native Windows workspace-write E2E", () => {
  let buildDirectory = "";
  let fixtureDirectory = "";
  let workspace = "";
  let privateTempBaseDirectory = "";
  let runnerPath = "";
  let runnerManifest: NativeSandboxRunnerManifest;
  let controller: NativeWorkspaceSandboxController;

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), "caelush-runtime-workspace-runner-"));
    fixtureDirectory = await mkdtemp(join(tmpdir(), "caelush-runtime-workspace-fixture-"));
    workspace = join(fixtureDirectory, "workspace");
    privateTempBaseDirectory = join(fixtureDirectory, "private-temp-base");
    await mkdir(workspace);
    await mkdir(privateTempBaseDirectory);

    const cargo =
      process.env.CARGO ??
      join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
    const built = await buildSandboxRunner({
      repositoryRoot: process.cwd(),
      outputDirectory: buildDirectory,
      cargo,
    });
    runnerPath = built.binaryPath;
    runnerManifest = built.manifest;
    controller = createNativeWorkspaceSandboxController({
      runnerPath,
      providerId,
      privateTempBaseDirectory,
      readyTimeoutMs: 5_000,
    });
  }, 120_000);

  afterAll(async () => {
    if (fixtureDirectory !== "") {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
    if (buildDirectory !== "") {
      await rm(buildDirectory, { recursive: true, force: true });
    }
  });

  it("confines a Runtime Provider to the prepared workspace and its own temp", async () => {
    await expect(controller.getStatus(workspace, "WORKSPACE_WRITE")).resolves.toBe("REQUIRED");
    await expect(controller.prepare(workspace, "WORKSPACE_WRITE")).resolves.toBe("READY");
    await expect(controller.getStatus(workspace, "WORKSPACE_WRITE")).resolves.toBe("READY");

    const sibling = join(fixtureDirectory, "sibling");
    const foreignTemp = join(fixtureDirectory, "foreign-temp");
    await mkdir(sibling);
    await mkdir(foreignTemp);

    const deleteTarget = join(workspace, "runtime-delete-target.txt");
    const renameSource = join(workspace, "runtime-rename-source.txt");
    const parentTarget = join(fixtureDirectory, "runtime-parent-denied.txt");
    const siblingTarget = join(sibling, "runtime-sibling-denied.txt");
    const foreignTempTarget = join(foreignTemp, "runtime-foreign-temp-denied.txt");
    const userTempTarget = join(
      tmpdir(),
      `caelush-runtime-user-temp-denied-${process.pid}-${Date.now()}.txt`,
    );
    await writeFile(deleteTarget, "delete-me\r\n");
    await writeFile(renameSource, "rename-me\r\n");

    const script = join(workspace, "runtime-workspace-write.cmd");
    const workspaceCreated = join(workspace, "runtime-created.txt");
    const workspaceObservedTemp = join(workspace, "runtime-observed-temp.txt");
    const runId = "run-runtime-matrix";
    const runTemp = await controller.createRunTemp(runId as never);
    await writeFile(join(runTemp.root, "runtime-temp-delete-target.txt"), "delete-me\r\n");
    await writeFile(
      script,
      [
        "@echo off",
        `> "runtime-created.txt" echo workspace-created`,
        `>> "runtime-created.txt" echo workspace-appended`,
        `move /y "runtime-rename-source.txt" "runtime-renamed.txt" >nul 2>nul`,
        `del /q "runtime-delete-target.txt" >nul 2>nul`,
        `> "%TEMP%\\runtime-temp-created.txt" echo temp-created`,
        `>> "%TEMP%\\runtime-temp-created.txt" echo temp-appended`,
        `move /y "%TEMP%\\runtime-temp-created.txt" "%TEMP%\\runtime-temp-renamed.txt" >nul 2>nul`,
        `del /q "%TEMP%\\runtime-temp-delete-target.txt" >nul 2>nul`,
        `type "%TEMP%\\runtime-temp-renamed.txt" > "runtime-observed-temp.txt"`,
        `> "${relative(workspace, parentTarget)}" echo parent-denied`,
        `> "${relative(workspace, siblingTarget)}" echo sibling-denied`,
        `> "${relative(workspace, foreignTempTarget)}" echo foreign-temp-denied`,
        `> "${relative(workspace, userTempTarget)}" echo user-temp-denied`,
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const provider = createProvider(
      runnerPath,
      runnerManifest,
      queuedControllerFor(controller, [runTemp]),
    );
    const adapter = await provider.create(createSpec(workspace, script, runId));
    const output: string[] = [];
    adapter.onOutput((event) => output.push(`${event.stream}:${event.text}`));
    const exit = await waitForAdapter(adapter);

    expect(exit).toMatchObject({ exitCode: 0 });
    if (!(await pathExists(workspaceCreated))) {
      throw new Error(`workspace payload output missing; child output: ${output.join("")}`);
    }
    await expect(readFile(workspaceCreated, "utf8")).resolves.toBe(
      "workspace-created\r\nworkspace-appended\r\n",
    );
    await expect(access(join(workspace, "runtime-renamed.txt"))).resolves.toBeUndefined();
    await expect(access(renameSource)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(deleteTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(workspaceObservedTemp, "utf8")).resolves.toBe(
      "temp-created\r\ntemp-appended\r\n",
    );
    await expect(access(parentTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(siblingTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(foreignTempTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(userTempTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(privateTempBaseDirectory)).resolves.toEqual([]);
  });

  it("isolates concurrent Runs in separate private temp directories and cleans both", async () => {
    const firstRunId = "run-runtime-temp-one" as never;
    const secondRunId = "run-runtime-temp-two" as never;
    const firstTemp = await controller.createRunTemp(firstRunId);
    const secondTemp = await controller.createRunTemp(secondRunId);
    const queuedTemps = [firstTemp, secondTemp];
    const queuedController = queuedControllerFor(controller, queuedTemps);
    const provider = createProvider(runnerPath, runnerManifest, queuedController);
    const firstForeign = join(secondTemp.root, "first-foreign.txt");
    const secondForeign = join(firstTemp.root, "second-foreign.txt");
    const firstScript = join(workspace, "runtime-first-run.cmd");
    const secondScript = join(workspace, "runtime-second-run.cmd");

    await writeFile(
      firstScript,
      [
        "@echo off",
        `> "%TEMP%\\first-own.txt" echo first-own`,
        `> "${relative(workspace, firstForeign)}" echo first-foreign`,
        "ping -n 2 127.0.0.1 >nul",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(
      secondScript,
      [
        "@echo off",
        `> "%TEMP%\\second-own.txt" echo second-own`,
        `> "${relative(workspace, secondForeign)}" echo second-foreign`,
        "ping -n 2 127.0.0.1 >nul",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const first = await provider.create(createSpec(workspace, firstScript, firstRunId));
    const second = await provider.create(createSpec(workspace, secondScript, secondRunId));
    const [firstExit, secondExit] = await Promise.all([
      waitForAdapter(first),
      waitForAdapter(second),
    ]);

    expect(firstExit).toMatchObject({ exitCode: 0 });
    expect(secondExit).toMatchObject({ exitCode: 0 });
    await expect(access(join(firstTemp.root, "first-own.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(secondTemp.root, "second-own.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(firstForeign)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(secondForeign)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(privateTempBaseDirectory)).resolves.toEqual([]);
  });
});

function createProvider(
  runnerPath: string,
  manifest: NativeSandboxRunnerManifest,
  workspaceController: NativeWorkspaceSandboxController,
) {
  return createWindowsAclRestrictedTokenProvider({
    platform: "win32",
    runnerPath,
    manifest,
    workspaceController,
  });
}

function queuedControllerFor(
  base: NativeWorkspaceSandboxController,
  temps: PrivateRunTemp[],
): NativeWorkspaceSandboxController {
  return Object.freeze({
    getStatus: (workspaceRoot: string, presetId: Parameters<typeof base.getStatus>[1]) =>
      base.getStatus(workspaceRoot, presetId),
    prepare: (workspaceRoot: string, presetId: Parameters<typeof base.prepare>[1]) =>
      base.prepare(workspaceRoot, presetId),
    createRunTemp: async () => {
      const temp = temps.shift();
      if (temp === undefined) throw new Error("private temp queue exhausted");
      return temp;
    },
    cleanupRunTemp: (temp: PrivateRunTemp) => base.cleanupRunTemp(temp),
  });
}

function createSpec(workspaceRoot: string, script: string, runId: string): SandboxedSpawnSpec {
  const executable = process.env.ComSpec ?? "cmd.exe";
  return {
    launch: {
      executable,
      args: ["/d", "/s", "/c", basename(script)],
    },
    cwd: workspaceRoot,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    tty: false,
    authorizationNonce: `runtime-workspace-write-${runId}`,
    policy: createRuntimeProcessPolicy({
      runId: runId as never,
      workspaceId: createWorkspaceId(),
      workspaceRoot,
      hostUserRoot: homedir(),
      filesystemBoundary: "WORKSPACE_READ_WRITE",
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
      protectedRoots: [workspaceRoot],
    }),
  };
}

function waitForAdapter(adapter: ManagedProcessAdapter): Promise<ProcessExit> {
  return new Promise<ProcessExit>((resolve, reject) => {
    let settled = false;
    adapter.onError((error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    adapter.onExit((exit) => {
      if (settled) return;
      settled = true;
      resolve(exit);
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
