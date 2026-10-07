import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  createNativeWorkspaceSandboxController,
  createRuntimeProcessPolicy,
  createWindowsAclRestrictedTokenProvider,
  type ManagedProcessAdapter,
  type NativeSandboxRunnerManifest,
  type NativeWorkspaceSandboxController,
  type ProcessExit,
  type SandboxedSpawnSpec,
} from "../src/index.js";
import {
  buildSandboxRunner,
  // @ts-expect-error The release helper is a checked-in JavaScript build script without a declaration file.
} from "../../../scripts/build-sandbox-runner.mjs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const providerId = "windows-acl-restricted-token";

/**
 * The environment variable the `test-fault-injection` build reads. It is the *message* marker too:
 * the same string must be absent from the shipped Runner, which is what makes "the production CLI
 * has no fault switch" a measured fact rather than a claim.
 */
const FAULT_ENVIRONMENT_VARIABLE = "CAELUSH_SANDBOX_FAULT_STAGE";
const FAULT_REASON_CODE = "WINDOWS_SANDBOX_FAULT_INJECTED";

/**
 * A single constant in the fault build that lists every accepted stage name.
 *
 * Individual names cannot be searched for: a short one such as `ready` also occurs inside ordinary
 * identifiers like `write_ready`. This prefixed, `|`-terminated marker can be read back out of a
 * build and compared exactly, which is how the stage list below is kept honest in both directions.
 */
const STAGE_MANIFEST_PREFIX = "caelush-fault-stage-manifest:";

/**
 * Every stage the Runner can be told to fail at, in the order the spawn sequence reaches them.
 *
 * Asserted against the build's own manifest, so this list and
 * `native/sandbox-runner/src/platform/windows/faults.rs` cannot drift apart.
 */
const FAULT_STAGES = [
  "before-token-create",
  "after-token-create",
  "workspace-grant",
  "temp-grant",
  "job-create",
  "job-configure",
  "process-create",
  "job-assign",
  "ready",
  "child-start",
] as const;

/**
 * Stages at or before process creation. The payload process is never created, so the payload's very
 * first write must not exist.
 */
const NO_PROCESS_STAGES = FAULT_STAGES.slice(0, 7);

/**
 * `job-assign` is reached after the process exists but before it is resumed or assigned to the Job
 * Object. The payload must still never run, and the suspended process must still be released.
 */
const SUSPENDED_PROCESS_STAGE = FAULT_STAGES[7];

/**
 * Stages reached after the target has been resumed. The payload may legitimately have started, so
 * the only honest claim is that the tree is dead: the delayed grandchild write must never appear,
 * and the control Run proves that write really does happen when nothing is injected.
 */
const RUNNING_PROCESS_STAGES = FAULT_STAGES.slice(8);

/** The grandchild waits this long before writing, so a killed tree has time to prove itself dead. */
const GRANDCHILD_DELAY_MS = 2_000;
const GRANDCHILD_DEADLINE_MS = 5_000;
const PROCESS_TREE_TEST_TIMEOUT_MS = 15_000;

describeWindows("native Windows sandbox fault closure", () => {
  let buildDirectory = "";
  let fixtureDirectory = "";
  let privateTempBaseDirectory = "";
  let productionRunnerPath = "";
  let productionRunnerBytes: Buffer;
  let faultRunnerPath = "";
  let runnerManifest: NativeSandboxRunnerManifest;
  let controller: NativeWorkspaceSandboxController;
  let caseIndex = 0;

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), "caelush-runtime-fault-build-"));
    fixtureDirectory = await mkdtemp(join(tmpdir(), "caelush-runtime-fault-fixture-"));
    privateTempBaseDirectory = join(fixtureDirectory, "private-temp-base");
    await mkdir(privateTempBaseDirectory);

    const cargo =
      process.env.CARGO ??
      join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
    const built = await buildSandboxRunner({
      repositoryRoot: process.cwd(),
      outputDirectory: buildDirectory,
      cargo,
    });
    productionRunnerPath = built.binaryPath;
    productionRunnerBytes = readFileSync(productionRunnerPath);

    const faultRunner = buildFaultInjectionRunner(cargo, buildDirectory, built.manifest);
    faultRunnerPath = faultRunner.binaryPath;
    runnerManifest = faultRunner.manifest;
    controller = createNativeWorkspaceSandboxController({
      runnerPath: faultRunnerPath,
      providerId,
      privateTempBaseDirectory,
      readyTimeoutMs: 5_000,
    });
  }, 300_000);

  afterAll(async () => {
    if (fixtureDirectory !== "") {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
    if (buildDirectory !== "") {
      await rm(buildDirectory, { recursive: true, force: true });
    }
  });

  it("ships no fault switch: the stages exist only in a test-fault-injection build", () => {
    for (const marker of [FAULT_ENVIRONMENT_VARIABLE, FAULT_REASON_CODE, STAGE_MANIFEST_PREFIX]) {
      expect(
        productionRunnerBytes.includes(Buffer.from(marker, "utf8")),
        `the default release Runner must not contain '${marker}'`,
      ).toBe(false);
    }
    const faultRunnerBytes = readFileSync(faultRunnerPath);
    for (const marker of [FAULT_ENVIRONMENT_VARIABLE, FAULT_REASON_CODE]) {
      expect(
        faultRunnerBytes.includes(Buffer.from(marker, "utf8")),
        `the fault-injection Runner must contain '${marker}'`,
      ).toBe(true);
    }
    // Read the build's own stage list back and compare it exactly. A stage renamed on either side
    // fails here rather than quietly reducing the suite to "the Runner refused for some reason".
    expect(declaredFaultStages(faultRunnerBytes)).toEqual([...FAULT_STAGES]);
  });

  it(
    "runs the payload to completion when no fault is injected",
    async () => {
      // The positive control for every post-start case below. Without it, "the delayed write is
      // absent" would be satisfied by a payload that never schedules anything.
      const workspace = await createWorkflow();
      const adapter = await createProvider().create(createSpec(workspace, "control"));
      const exit = await waitForAdapter(adapter);
      await adapter.close().catch(() => undefined);
      await settleGrandchild();

      expect(exit).toMatchObject({ exitCode: 0 });
      await expect(readFile(join(workspace, "started.txt"), "utf8")).resolves.toBe("started\r\n");
      await expect(readFile(join(workspace, "late.txt"), "utf8")).resolves.toBe("late\r\n");
      await expect(readdir(privateTempBaseDirectory)).resolves.toEqual([]);
    },
    PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  for (const stage of NO_PROCESS_STAGES) {
    it(`never starts the payload when '${stage}' fails`, async () => {
      const result = await runFaultCase(stage);
      expectFailureBeforeReady(result, stage);
      await expect(access(join(result.workspace, "started.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(join(result.workspace, "late.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  }

  it(`never runs a suspended payload when '${SUSPENDED_PROCESS_STAGE}' fails`, async () => {
    const result = await runFaultCase(SUSPENDED_PROCESS_STAGE);
    expectFailureBeforeReady(result, SUSPENDED_PROCESS_STAGE);
    await expect(access(join(result.workspace, "started.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(result.workspace, "late.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  for (const stage of RUNNING_PROCESS_STAGES) {
    it(
      `terminates the process tree when '${stage}' fails after the payload started`,
      async () => {
        const result = await runFaultCase(stage);
        if (stage === "ready") {
          // READY is never sent, so the Run is refused before it is handed to the caller.
          expectFailureBeforeReady(result, stage);
        } else {
          // READY was sent, so the failure surfaces as the Run's own exit code.
          expect(result.rejection).toBeUndefined();
          expect(result.exit).toMatchObject({ exitCode: 1 });
        }
        await expect(access(join(result.workspace, "late.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      PROCESS_TREE_TEST_TIMEOUT_MS,
    );
  }

  it(
    "leaves the workspace usable by the host user and by later Runs after every fault",
    async () => {
      // "Unchanged user ACEs" observed the only way it can be observed from outside: the host user
      // can still do ordinary file work, a fresh Run can still be prepared and confined, and no
      // private temp directory is left behind from any of the faults above.
      await expect(readdir(privateTempBaseDirectory)).resolves.toEqual([]);

      // The grant that was prepared before the faults is still whole, not half-applied or orphaned:
      // the Runner still confirms it. Paired with the unprepared workspace below, which must still
      // report REQUIRED, so neither answer is a controller that always says the same thing.
      const workspace = await createWorkflow();
      await expect(controller.getStatus(workspace, "WORKSPACE_WRITE")).resolves.toBe("READY");

      const untouched = join(fixtureDirectory, `workspace-unprepared-${caseIndex}`);
      caseIndex += 1;
      await mkdir(untouched, { recursive: true });
      await expect(controller.getStatus(untouched, "WORKSPACE_WRITE")).resolves.toBe("REQUIRED");

      const scratch = join(workspace, "host-created.txt");
      await writeFile(scratch, "host-created\r\n");
      await expect(readFile(scratch, "utf8")).resolves.toBe("host-created\r\n");
      await rm(scratch);

      const adapter = await createProvider().create(createSpec(workspace, "recovery"));
      const exit = await waitForAdapter(adapter);
      await adapter.close().catch(() => undefined);
      await settleGrandchild();
      expect(exit).toMatchObject({ exitCode: 0 });
      await expect(readFile(join(workspace, "late.txt"), "utf8")).resolves.toBe("late\r\n");
      await expect(readdir(privateTempBaseDirectory)).resolves.toEqual([]);
    },
    PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  function createProvider() {
    return createWindowsAclRestrictedTokenProvider({
      platform: "win32",
      arch: process.arch,
      runnerPath: faultRunnerPath,
      manifest: runnerManifest,
      workspaceController: controller,
      readyTimeoutMs: 5_000,
    });
  }

  async function createWorkflow(): Promise<string> {
    const workspace = join(fixtureDirectory, `workspace-${caseIndex}`);
    caseIndex += 1;
    await mkdir(workspace, { recursive: true });
    // Workspace-internal paths are addressed relatively. An absolute path embedded in batch text is
    // mis-decoded by `cmd.exe` on a host whose temp directory is non-ASCII, which would turn "the
    // sandbox denied the write" into "the harness wrote a path that does not exist".
    await writeFile(
      join(workspace, "grandchild.cmd"),
      [
        "@echo off",
        `ping -n ${Math.ceil(GRANDCHILD_DELAY_MS / 1000) + 1} 127.0.0.1 >nul`,
        '> "late.txt" echo late',
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, "payload.cmd"),
      [
        "@echo off",
        '> "started.txt" echo started',
        "cmd /d /s /c grandchild.cmd",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await expect(controller.prepare(workspace, "WORKSPACE_WRITE")).resolves.toBe("READY");
    return workspace;
  }

  async function runFaultCase(stage: string): Promise<FaultCase> {
    const workspace = await createWorkflow();
    const spec = createSpec(workspace, stage, {
      [FAULT_ENVIRONMENT_VARIABLE]: stage,
    });
    let adapter: ManagedProcessAdapter | undefined;
    let rejection: unknown;
    let exit: ProcessExit | undefined;
    try {
      adapter = await createProvider().create(spec);
      exit = await waitForAdapter(adapter);
    } catch (error) {
      rejection = error;
    } finally {
      await adapter?.close().catch(() => undefined);
      if (stage === "ready" || stage === "child-start") await settleGrandchild();
    }
    return { workspace, rejection, exit };
  }

  function expectFailureBeforeReady(result: FaultCase, stage: string): void {
    expect(result.rejection, `stage '${stage}' must refuse the Run before READY`).toBeInstanceOf(
      Error,
    );
    // Never degrade into an unrestricted spawn: the Run must not have been handed back at all.
    expect(result.exit).toBeUndefined();
  }
});

interface FaultCase {
  readonly workspace: string;
  readonly rejection: unknown;
  readonly exit: ProcessExit | undefined;
}

/**
 * Builds the `test-fault-injection` Runner into its own cargo target directory and hashes it.
 *
 * A separate target directory is deliberate: the default-feature build that ships, and that the
 * other Windows suites build, must not be invalidated or silently replaced by a fault-capable one.
 */
function buildFaultInjectionRunner(
  cargo: string,
  buildDirectory: string,
  manifest: NativeSandboxRunnerManifest,
): { readonly binaryPath: string; readonly manifest: NativeSandboxRunnerManifest } {
  const targetDirectory = join(buildDirectory, "fault-target");
  const result = spawnSync(
    cargo,
    [
      "build",
      "--release",
      "--features",
      "test-fault-injection",
      "--manifest-path",
      join(process.cwd(), "native", "sandbox-runner", "Cargo.toml"),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
      // `cargo build` never reads stdin; an inherited stdout can fail with EBUSY on Windows.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to build the fault-injection Runner: ${result.stderr || result.stdout || "no output"}`,
    );
  }
  const binaryPath = join(
    targetDirectory,
    "release",
    process.platform === "win32" ? "caelush-sandbox-runner.exe" : "caelush-sandbox-runner",
  );
  // The fault build is the same program with extra hooks, so the only manifest field that can
  // differ is the hash. Reusing the shipped shape keeps the artifact checker on its normal path.
  return Object.freeze({
    binaryPath,
    manifest: Object.freeze({ ...manifest, sha256: checksumOf(binaryPath) }),
  });
}

function checksumOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Reads the stage manifest a `test-fault-injection` build carries, back out of the binary.
 *
 * The manifest is compiled in as one prefixed, `|`-terminated literal, so this is an exact read of
 * what the program itself accepts rather than a second copy of the list that could drift from it.
 * Throws when the marker is absent or unterminated: "this build does not declare its stages" must
 * fail the test that asked, not silently return an empty list.
 */
function declaredFaultStages(bytes: Buffer): string[] {
  const text = bytes.toString("utf8");
  const markerStart = text.indexOf(STAGE_MANIFEST_PREFIX);
  if (markerStart === -1) {
    throw new Error(`the build does not declare '${STAGE_MANIFEST_PREFIX}'`);
  }
  const bodyStart = markerStart + STAGE_MANIFEST_PREFIX.length;
  const bodyEnd = text.indexOf("|", bodyStart);
  if (bodyEnd === -1) {
    throw new Error("the build's stage manifest is not terminated by '|'");
  }
  return text.slice(bodyStart, bodyEnd).split(",");
}

function createSpec(
  workspaceRoot: string,
  label: string,
  extraEnv: Readonly<Record<string, string>> = {},
): SandboxedSpawnSpec {
  const executable = process.env.ComSpec ?? "cmd.exe";
  return {
    launch: {
      executable,
      args: ["/d", "/s", "/c", "payload.cmd"],
    },
    cwd: workspaceRoot,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...extraEnv,
    },
    tty: false,
    authorizationNonce: `runtime-sandbox-fault-${label}`,
    policy: createRuntimeProcessPolicy({
      runId: `run-fault-${label}` as never,
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

/** Waits longer than the grandchild's delay so an absent write is evidence, not a timing artefact. */
function settleGrandchild(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, GRANDCHILD_DEADLINE_MS));
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
