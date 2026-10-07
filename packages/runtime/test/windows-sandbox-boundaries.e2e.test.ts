import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
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
 * The classification every case below must produce.
 *
 * The Windows backend is `PARTIAL`: it constrains write *effects* and does not claim to isolate
 * reads, network, or process visibility (design section 4.9), and full network isolation as well as
 * process-namespace hiding are explicitly out of scope (section 14). A suite that only proved
 * "writes outside the workspace fail" would leave the rest of that sentence untested, and `PARTIAL`
 * would be a claim rather than a measurement. So each boundary gets exactly one of these:
 *
 * - `ENFORCED` - the product constrains it, proven by a final filesystem fact.
 * - `REJECTED_DURING_PREPARATION` - the product refuses the input before any payload is created.
 * - `DOCUMENTED_PARTIAL` - deliberately not constrained, and the specification says so.
 */
type Classification = "ENFORCED" | "REJECTED_DURING_PREPARATION" | "DOCUMENTED_PARTIAL";

const CLASSIFICATION_LABELS: Readonly<Record<Classification, string>> = Object.freeze({
  ENFORCED: "enforced",
  REJECTED_DURING_PREPARATION: "rejected during preparation",
  DOCUMENTED_PARTIAL: "documented partial boundary",
});

const BOUNDARY_COUNT = 9;

const recordedClassifications: { boundary: string; classification: Classification }[] = [];

/** Records one boundary's verdict. Every case must call this, which the last test enforces. */
function classify(boundary: string, classification: Classification): void {
  recordedClassifications.push({ boundary, classification });
}

describeWindows("native Windows sandbox enforcement boundaries", () => {
  let buildDirectory = "";
  let fixtureDirectory = "";
  let privateTempBaseDirectory = "";
  let runnerPath = "";
  let runnerManifest: NativeSandboxRunnerManifest;
  let controller: NativeWorkspaceSandboxController;
  let caseIndex = 0;

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), "caelush-runtime-boundaries-runner-"));
    fixtureDirectory = await mkdtemp(join(tmpdir(), "caelush-runtime-boundaries-fixture-"));
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
    runnerPath = built.binaryPath;
    runnerManifest = built.manifest;
    controller = createNativeWorkspaceSandboxController({
      runnerPath,
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

  it("does not constrain reads outside the workspace under VIEW_ONLY", async () => {
    // The spec says the backend constrains write effects and does not claim to isolate reads. That
    // is a boundary, not a defect, but it is the one most likely to be silently assumed away, so it
    // is asserted positively: the payload must actually read the outside file.
    const workspace = await createWorkspace("read-outside", "WORKSPACE_WRITE");
    const outsideSecret = `outside-readable-${caseIndex}`;
    const outsidePath = join(fixtureDirectory, "outside-readable.txt");
    await writeFile(outsidePath, `${outsideSecret}\r\n`, "utf8");

    const { exit, output } = await runScript(
      workspace,
      "read-outside.cmd",
      [
        "@echo off",
        "echo READ-OUTSIDE-BEGIN",
        // Relative from the workspace, so no absolute path is embedded in batch text: `cmd.exe`
        // reads a batch file in the console code page, and this host's temp path is not ASCII.
        'type "..\\outside-readable.txt"',
        "echo READ-OUTSIDE-END",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "WORKSPACE_WRITE",
    );

    expect(exit).toMatchObject({ exitCode: 0 });
    const observed = between(output, "READ-OUTSIDE-BEGIN", "READ-OUTSIDE-END");
    expect(observed, `payload output: ${output.join("")}`).toContain(outsideSecret);
    classify("read outside the workspace (VIEW_ONLY)", "DOCUMENTED_PARTIAL");
  });

  it("does not widen write authority through a hard link to a file outside the workspace", async () => {
    const workspace = await createWorkspace("hard-link", "WORKSPACE_WRITE");
    const outsidePath = join(fixtureDirectory, "outside-hard-link-target.txt");
    const originalOutside = "outside-must-stay-unchanged\r\n";
    await writeFile(outsidePath, originalOutside, "utf8");
    const linkPath = join(workspace, "link-to-outside.txt");
    await link(outsidePath, linkPath);
    await expectIsRealHardLink(outsidePath, linkPath);

    const { exit, output } = await runScript(
      workspace,
      "hard-link.cmd",
      [
        "@echo off",
        "echo LINK-READ-BEGIN",
        'type "link-to-outside.txt"',
        "echo LINK-READ-END",
        // Both of these use the same redirect operator. The local one is the control: if it lands,
        // the mechanism works and the outside file staying untouched means the link write was denied.
        '>> "link-to-outside.txt" echo sneaked-through-link',
        '>> "workspace-local-appended.txt" echo local-append',
        "exit /b 0",
        "",
      ].join("\r\n"),
      "WORKSPACE_WRITE",
    );

    expect(exit).toMatchObject({ exitCode: 0 });
    expect(between(output, "LINK-READ-BEGIN", "LINK-READ-END")).toContain(
      originalOutside.trimEnd(),
    );
    // A hard link shares the target's security descriptor, so the workspace capability SID grants
    // nothing through it and both the read* and the write are governed by the target's own ACL.
    await expect(readFile(join(workspace, "workspace-local-appended.txt"), "utf8")).resolves.toBe(
      "local-append\r\n",
    );
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(originalOutside);
    classify("read through a hard link to an outside file", "DOCUMENTED_PARTIAL");
    classify("write through a hard link to an outside file", "ENFORCED");
  });

  it("does not widen write authority through a junction inside the workspace", async () => {
    const workspace = await createWorkspace("junction", "WORKSPACE_WRITE");
    const outsideDirectory = join(fixtureDirectory, "outside-junction-target");
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "inside.txt"), "outside-dir-content\r\n", "utf8");

    // `type: "junction"` asks Node for the privilege-free reparse kind. A directory *symlink* cannot
    // be relied on: on this host `CreateSymbolicLinkW` reports success while materialising an
    // ordinary directory, so the junction is both the portable and the honest fixture.
    const junctionPath = join(workspace, "junction-to-outside");
    await symlink(outsideDirectory, junctionPath, "junction");
    await expectResolvesToTarget(junctionPath, outsideDirectory);

    const { exit, output } = await runScript(
      workspace,
      "junction.cmd",
      [
        "@echo off",
        "echo JUNCTION-READ-BEGIN",
        'type "junction-to-outside\\inside.txt"',
        "echo JUNCTION-READ-END",
        '>> "junction-to-outside\\sneaked.txt" echo sneaked-through-junction',
        '>> "workspace-local-appended.txt" echo local-append',
        "exit /b 0",
        "",
      ].join("\r\n"),
      "WORKSPACE_WRITE",
    );

    expect(exit).toMatchObject({ exitCode: 0 });
    // The read proves the junction really resolves, so the denied write below is about the ACL on
    // the target rather than about a link that never worked.
    expect(between(output, "JUNCTION-READ-BEGIN", "JUNCTION-READ-END")).toContain(
      "outside-dir-content",
    );
    await expect(readdir(outsideDirectory)).resolves.toEqual(["inside.txt"]);
    await expect(readFile(join(workspace, "workspace-local-appended.txt"), "utf8")).resolves.toBe(
      "local-append\r\n",
    );
    classify("read through a junction to a directory outside the workspace", "DOCUMENTED_PARTIAL");
    classify("write through a junction to a directory outside the workspace", "ENFORCED");
  });

  it("rejects a reparse point as the workspace root without falling back to an unrestricted Run", async () => {
    const outsideDirectory = join(fixtureDirectory, "outside-root-target");
    await mkdir(outsideDirectory);
    const junctionRoot = join(fixtureDirectory, "junction-workspace-root");
    await symlink(outsideDirectory, junctionRoot, "junction");
    await expectResolvesToTarget(junctionRoot, outsideDirectory);

    // Fail-closed, and not silently repaired: neither a capability query nor a preparation may turn
    // a refused workspace into a permitted one.
    await expect(controller.getStatus(junctionRoot, "WORKSPACE_WRITE")).resolves.toBe(
      "UNAVAILABLE",
    );
    await expect(controller.prepare(junctionRoot, "WORKSPACE_WRITE")).resolves.toEqual({
      status: "FAILED",
      reasonCode: "WINDOWS_PATH_BOUNDARY_REPARSE_UNSUPPORTED",
    });

    // The control proves those two answers come from the reparse point and not from a controller
    // that cannot prepare anything at all.
    const ordinary = await createWorkspace("ordinary-root", "WORKSPACE_WRITE");
    await expect(controller.getStatus(ordinary, "WORKSPACE_WRITE")).resolves.toBe("READY");

    // And an actual Run against the refused root must be refused too - no unrestricted fallback.
    // The payload would exit 9, so a fallback that started it could not be mistaken for a refusal.
    const provider = createProvider();
    await expect(
      provider.create(
        createSpec({
          workspaceRoot: junctionRoot,
          launch: { executable: process.execPath, args: ["-e", "process.exit(9)"] },
          boundary: "WORKSPACE_WRITE",
          label: "reparse-root",
        }),
      ),
    ).rejects.toThrow();
    await expect(readdir(privateTempBaseDirectory)).resolves.toEqual([]);
    classify(
      "a directory reparse point offered as the workspace root",
      "REJECTED_DURING_PREPARATION",
    );
  });

  it("does not constrain loopback network access", async () => {
    const workspace = await createWorkspace("network", "WORKSPACE_WRITE");
    const script = (port: number): string[] => [
      "-e",
      [
        // The readiness line is the control for the exit code: without it, a payload that never
        // started would be indistinguishable from one whose connection was refused.
        "process.stdout.write('NET-PROBE-READY');",
        "const net=require('node:net');",
        `const socket=net.connect(${port},'127.0.0.1');`,
        "socket.on('connect',()=>{socket.destroy();process.exit(0)});",
        "socket.on('error',(error)=>{process.stderr.write('connect '+error.code);process.exit(3)});",
        "setTimeout(()=>process.exit(4),4000);",
      ].join(""),
    ];

    // A listener the sandbox can reach, then the one port it cannot: without the second half,
    // "exit 0" would not distinguish a permitted connection from a payload that never tried.
    const reachable = await openLoopbackListener();
    try {
      const permitted = await runNode(
        workspace,
        script(reachable.port),
        "network-open",
        "WORKSPACE_WRITE",
      );
      expect(permitted.output.join("")).toContain("NET-PROBE-READY");
      expect(describeRun(permitted)).toMatchObject({ exitCode: 0 });
      const unreachablePort = await closedLoopbackPort();
      const refused = await runNode(
        workspace,
        script(unreachablePort),
        "network-closed",
        "WORKSPACE_WRITE",
      );
      expect(refused.output.join("")).toContain("NET-PROBE-READY");
      expect(describeRun(refused)).toMatchObject({ exitCode: 3 });
    } finally {
      await reachable.close();
    }

    classify("loopback network access from inside the sandbox", "DOCUMENTED_PARTIAL");
  }, 120_000);

  it("does not provide a separate process namespace", async () => {
    // Section 14 puts process-namespace hiding out of scope, so the honest test is that the
    // sandboxed process is still an ordinary member of the host's process list. Measuring it the
    // other way round - a payload that enumerates the host - would have tested `tasklist`'s own
    // rights rather than the existence of a namespace; see the second half of this case.
    const workspace = await createWorkspace("process-namespace", "WORKSPACE_WRITE");
    const announce = join(workspace, "announce.js");
    await writeFile(
      announce,
      [
        "const fs = require('node:fs');",
        // Inside the workspace, which the prepared Run may write to, and addressed relatively so the
        // payload never depends on an absolute path.
        "fs.writeFileSync('payload-pid.txt', String(process.pid));",
        "setTimeout(() => process.exit(0), 20000);",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const adapter = await createProvider().create(
      createSpec({
        workspaceRoot: workspace,
        launch: { executable: process.execPath, args: [announce] },
        boundary: "WORKSPACE_WRITE",
        label: "process-namespace",
      }),
    );
    try {
      const announced = join(workspace, "payload-pid.txt");
      const payloadPid = await waitForPidFile(announced, 20_000);
      const listing = await hostTasklist(`PID eq ${payloadPid}`);
      expect(listing, `host tasklist could not see payload pid ${payloadPid}`).toContain(
        String(payloadPid),
      );
      expect(listing).toContain(basename(process.execPath));
    } finally {
      await adapter.close().catch(() => undefined);
    }
    classify("the sandboxed process in the host process namespace", "DOCUMENTED_PARTIAL");

    // The converse, measured rather than assumed: a restricted payload cannot enumerate processes
    // itself. That is a property of the restricted token's rights, not an attempt to hide anything,
    // and it is worth pinning because it is also evidence the token really is restricted.
    const viewWorkspace = await createWorkspace("process-enumeration", "WORKSPACE_READ_ONLY");
    const { exit, output } = await runScript(
      viewWorkspace,
      "enumerate.cmd",
      [
        "@echo off",
        "echo ENUMERATE-BEGIN",
        // `/NH` with no filter: the enumeration itself, not the argument parsing.
        "tasklist /NH",
        "echo ENUMERATE-END",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "WORKSPACE_READ_ONLY",
    );
    expect(exit, `payload output: ${output.join("")}`).toMatchObject({ exitCode: 0 });
    const enumerated = between(output, "ENUMERATE-BEGIN", "ENUMERATE-END");
    expect(enumerated, `payload output: ${output.join("")}`).not.toContain(
      basename(process.execPath),
    );
    classify("a restricted payload enumerating host processes", "ENFORCED");
  }, 120_000);

  it("records one classification for every boundary and none by omission", () => {
    const table = recordedClassifications
      .map((entry) => `${entry.boundary.padEnd(58)} ${CLASSIFICATION_LABELS[entry.classification]}`)
      .join("\n");
    process.stdout.write(`windows sandbox enforcement boundaries\n${table}\n`);
    // A boundary that stopped being measured must fail here rather than quietly disappear from the
    // evidence, which is the failure mode this whole file exists to prevent.
    expect(recordedClassifications).toHaveLength(BOUNDARY_COUNT);
    expect(new Set(recordedClassifications.map((entry) => entry.boundary)).size).toBe(
      BOUNDARY_COUNT,
    );
  });

  function createProvider() {
    return createWindowsAclRestrictedTokenProvider({
      platform: "win32",
      arch: process.arch,
      runnerPath,
      manifest: runnerManifest,
      workspaceController: controller,
      readyTimeoutMs: 5_000,
    });
  }

  /** Creates a workspace, preparing it when the boundary needs write authority. */
  async function createWorkspace(label: string, boundary: BoundaryKind): Promise<string> {
    const workspace = join(fixtureDirectory, `workspace-${label}-${caseIndex}`);
    caseIndex += 1;
    await mkdir(workspace, { recursive: true });
    if (boundary === "WORKSPACE_READ_ONLY") {
      // VIEW_ONLY needs no preparation: the read boundary is just the user's own ACLs.
      await expect(controller.getStatus(workspace, "VIEW_ONLY")).resolves.toBe("READY");
      return workspace;
    }
    await expect(controller.getStatus(workspace, "WORKSPACE_WRITE")).resolves.toBe("REQUIRED");
    await expect(controller.prepare(workspace, "WORKSPACE_WRITE")).resolves.toBe("READY");
    return workspace;
  }

  async function runScript(
    workspace: string,
    name: string,
    body: string,
    boundary: BoundaryKind,
  ): Promise<BoundaryRun> {
    const script = join(workspace, name);
    await writeFile(script, body, "utf8");
    return runSpec(
      createSpec({
        workspaceRoot: workspace,
        launch: {
          executable: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", name],
        },
        boundary,
        label: name,
      }),
    );
  }

  async function runNode(
    workspace: string,
    args: string[],
    label: string,
    boundary: BoundaryKind,
  ): Promise<BoundaryRun> {
    return runSpec(
      createSpec({
        workspaceRoot: workspace,
        launch: { executable: process.execPath, args },
        boundary,
        label,
      }),
    );
  }

  async function runSpec(spec: SandboxedSpawnSpec): Promise<BoundaryRun> {
    const adapter = await createProvider().create(spec);
    try {
      const output: string[] = [];
      const stopOutput = adapter.onOutput((event) => output.push(event.text));
      try {
        return { exit: await waitForAdapter(adapter), output };
      } finally {
        stopOutput();
      }
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }
});

type BoundaryKind = "WORKSPACE_READ_ONLY" | "WORKSPACE_WRITE";

interface BoundaryRun {
  readonly exit: ProcessExit;
  readonly output: readonly string[];
}

function createSpec(input: {
  readonly workspaceRoot: string;
  readonly launch: { readonly executable: string; readonly args: string[] };
  readonly boundary: BoundaryKind;
  readonly label: string;
}): SandboxedSpawnSpec {
  const readOnly = input.boundary === "WORKSPACE_READ_ONLY";
  return {
    launch: input.launch,
    cwd: input.workspaceRoot,
    env: sandboxEnvironment(),
    tty: false,
    authorizationNonce: `runtime-sandbox-boundary-${input.label}-${Date.now()}`,
    policy: createRuntimeProcessPolicy({
      runId: `run-boundary-${input.label}` as never,
      workspaceId: createWorkspaceId(),
      workspaceRoot: input.workspaceRoot,
      hostUserRoot: homedir(),
      filesystemBoundary: readOnly ? "WORKSPACE_READ_ONLY" : "WORKSPACE_READ_WRITE",
      processBoundary: readOnly ? "READ_ONLY" : "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
      protectedRoots: [input.workspaceRoot],
    }),
  };
}

/**
 * The Run's environment, without the host agent's Node preload hook.
 *
 * This suite runs *inside* WorkBuddy, which exports `NODE_OPTIONS=--require <host shim>`. A
 * sandboxed `node` payload inherits it and dies during startup with `MODULE_NOT_FOUND` before
 * executing a line of its own script - which would show up as "the sandbox blocked the network" or
 * "the payload never started a process", i.e. as a product finding that is not one. `node --version`
 * succeeds under the same sandbox, which is what proves the difference is the preload and not the
 * token.
 */
function sandboxEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.NODE_OPTIONS;
  return environment;
}

/**
 * Extracts the text between two marker lines.
 *
 * Every case marks its own output, so "the payload printed nothing" and "the payload was never
 * created" cannot both look like an empty string being asserted for absence.
 */
function between(output: readonly string[], begin: string, end: string): string {
  const text = output.join("");
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    throw new Error(`payload output is missing '${begin}'..'${end}': ${text}`);
  }
  return text.slice(start + begin.length, stop);
}

/** Requires a measured, real hard link: same volume and same file index, with two names. */
async function expectIsRealHardLink(target: string, linkPath: string): Promise<void> {
  const [targetStat, linkStat] = await Promise.all([lstat(target), lstat(linkPath)]);
  if (targetStat.ino !== linkStat.ino || targetStat.dev !== linkStat.dev) {
    throw new Error(
      "this host did not create a real hard link, so 'a hard link does not widen write authority' " +
        `cannot be measured (target ino=${targetStat.ino} dev=${targetStat.dev}, ` +
        `link ino=${linkStat.ino} dev=${linkStat.dev})`,
    );
  }
}

/** Requires the created link to resolve to `target`, which is only true for a real reparse point. */
async function expectResolvesToTarget(linkPath: string, target: string): Promise<void> {
  const [resolved, expected] = await Promise.all([realpath(linkPath), realpath(target)]);
  if (resolved !== expected) {
    throw new Error(
      `'${linkPath}' resolves to '${resolved}' instead of '${expected}', so no reparse point was ` +
        "created and the boundary it is meant to test is not present",
    );
  }
}

async function openLoopbackListener(): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the loopback listener did not report a port");
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Binds a port and gives it straight back, so the sandbox has somewhere a connection must fail. */
async function closedLoopbackPort(): Promise<number> {
  const listener = await openLoopbackListener();
  const port = listener.port;
  await listener.close();
  return port;
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

/**
 * The Run's exit code together with everything it printed.
 *
 * A bare `exitCode` mismatch would say only "1 !== 0"; a payload that dies during startup and one
 * whose connection is refused are very different findings, and only the output tells them apart.
 */
function describeRun(run: BoundaryRun): {
  readonly exitCode: number | undefined;
  readonly output: string;
} {
  return { exitCode: run.exit.exitCode, output: run.output.join("") };
}

/** Runs `tasklist` on the host - outside the sandbox - and returns its stdout. */
async function hostTasklist(filter: string): Promise<string> {
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
  const child = spawn(executable, ["/FI", filter, "/NH"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`host tasklist exited with code ${String(exitCode)}`);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Waits for the sandboxed payload to publish its own pid, which only a running process can do. */
async function waitForPidFile(path: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not published yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the sandboxed payload never published a pid at ${path}`);
}
