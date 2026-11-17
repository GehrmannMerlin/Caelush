import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeReadOnlyResource, type ReadOnlyResourcePolicy } from "@caelush/security";
import { createWorkspaceId } from "@caelush/protocol";
import {
  createNativeWorkspaceSandboxController,
  createAuthorizedRuntimeExecution,
  createRuntimeProcessPolicy,
  createWindowsAclRestrictedTokenProvider,
  LocalProcessManager,
  LocalRuntime,
  RuntimeAuthorizationError,
  type NativeSandboxRunnerManifest,
} from "../src/index.js";
import {
  buildSandboxRunner,
  // @ts-expect-error The release helper is a checked-in JavaScript build script without a declaration file.
} from "../../../scripts/build-sandbox-runner.mjs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("Runtime authorized read-only Skill resources", () => {
  let buildDirectory = "";
  let fixtureDirectory = "";
  let workspace = "";
  let resourceRoot = "";
  let adjacentUserDirectory = "";
  let runnerPath = "";
  let runnerManifest: NativeSandboxRunnerManifest;

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), "caelush-runtime-skill-runner-"));
    fixtureDirectory = await mkdtemp(join(tmpdir(), "caelush-skill-fixture-中文-"));
    workspace = join(fixtureDirectory, "workspace space");
    resourceRoot = join(workspace, ".caelush", "skills", "Skill Bundle 中文");
    adjacentUserDirectory = join(fixtureDirectory, "Adjacent User Data");
    await mkdir(join(fixtureDirectory, "private temp base"));
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(resourceRoot, "scripts"), { recursive: true }),
      mkdir(adjacentUserDirectory),
    ]);
    const ownerSid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
    }).match(/S-1-(?:\d+-)+\d+/u)?.[0];
    if (ownerSid === undefined) throw new Error("could not resolve the test user's Windows SID");
    execFileSync(
      "icacls.exe",
      [
        adjacentUserDirectory,
        "/inheritance:r",
        "/grant:r",
        `*${ownerSid}:(OI)(CI)F`,
        "SYSTEM:(OI)(CI)F",
      ],
      { stdio: "pipe" },
    );

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
  }, 120_000);

  afterAll(async () => {
    if (fixtureDirectory !== "") await rm(fixtureDirectory, { recursive: true, force: true });
    if (buildDirectory !== "") await rm(buildDirectory, { recursive: true, force: true });
  });

  it("reads only the granted frozen bundle through executeArgvAuthorized and preserves workspace writes", async () => {
    const resourceFile = join(resourceRoot, "scripts", "version.txt");
    const externalResourceRoot = join(fixtureDirectory, "USER Skill Bundle 中文");
    const externalResourceFile = join(externalResourceRoot, "scripts", "version.txt");
    const adjacentFile = join(adjacentUserDirectory, "private.txt");
    const probe = join(workspace, "probe.cmd");
    const frozenContent = "FROZEN_SKILL_RESOURCE_V1\r\n";
    await mkdir(join(externalResourceRoot, "scripts"), { recursive: true });
    await writeFile(resourceFile, frozenContent, "utf8");
    await writeFile(externalResourceFile, "FROZEN_USER_SKILL_RESOURCE_V1\r\n", "utf8");
    await writeFile(adjacentFile, "ADJACENT_PRIVATE_CONTENT\r\n", "utf8");
    await writeFile(
      probe,
      [
        "@echo off",
        'type "%~1" > "%~3-resource-read.txt" 2>nul || (echo DENIED>"%~3-resource-read-failed.txt" & exit /b 21)',
        'type "%~2" > "%~3-adjacent-read.txt" 2>nul && (echo READABLE>"%~3-adjacent-readable.txt") || (echo DENIED>"%~3-adjacent-denied.txt")',
        'echo MUTATED>>"%~1" 2>nul && (echo WRITABLE>"%~3-resource-write-ok.txt") || (echo DENIED>"%~3-resource-write-denied.txt")',
        'echo workspace-write-ok>"%~3-workspace-write.txt"',
        'echo temp-write-ok>"%TEMP%\\%~3-skill-temp-write.txt" || exit /b 22',
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const resourceIdentity = {
      resourceId: "binding_skill_bundle_v1",
      bundleRevision: "bundle_revision_v1",
      canonicalRoot: resourceRoot.replaceAll("\\", "/"),
      contentManifestHash: createHash("sha256").update(frozenContent).digest("hex"),
    };
    const externalResourceIdentity = {
      resourceId: "binding_user_skill_bundle_v1",
      bundleRevision: "bundle_revision_user_v1",
      canonicalRoot: externalResourceRoot.replaceAll("\\", "/"),
      contentManifestHash: createHash("sha256")
        .update("FROZEN_USER_SKILL_RESOURCE_V1\r\n")
        .digest("hex"),
    };
    const readOnlyPolicy: ReadOnlyResourcePolicy = {
      runId: "run_skill_read_only_resource" as never,
      revision: "security_policy_v1",
      enabled: true,
      expiresAt: Date.now() + 30_000,
      resources: [resourceIdentity, externalResourceIdentity],
    };
    const evaluationTime = Date.now();
    const projectDecision = authorizeReadOnlyResource(
      { runId: readOnlyPolicy.runId, ...resourceIdentity },
      readOnlyPolicy,
      evaluationTime,
    );
    const userDecision = authorizeReadOnlyResource(
      { runId: readOnlyPolicy.runId, ...externalResourceIdentity },
      readOnlyPolicy,
      evaluationTime,
    );
    expect(projectDecision.kind).toBe("ALLOW");
    expect(userDecision.kind).toBe("ALLOW");
    if (projectDecision.kind !== "ALLOW" || userDecision.kind !== "ALLOW") {
      throw new Error("the fixture resources should be authorized");
    }

    const workspaceId = createWorkspaceId();
    const controller = createNativeWorkspaceSandboxController({
      runnerPath,
      providerId: "windows-acl-restricted-token",
      privateTempBaseDirectory: join(fixtureDirectory, "private temp base"),
    });
    await expect(controller.prepare(workspace, "WORKSPACE_WRITE")).resolves.toBe("READY");
    const policy = createRuntimeProcessPolicy({
      runId: readOnlyPolicy.runId,
      workspaceId,
      workspaceRoot: workspace,
      hostUserRoot: homedir(),
      filesystemBoundary: "WORKSPACE_READ_WRITE",
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
      readOnlyResources: readOnlyPolicy,
    });
    const provider = createWindowsAclRestrictedTokenProvider({
      platform: "win32",
      runnerPath,
      manifest: runnerManifest,
      privateTempBaseDirectory: join(fixtureDirectory, "private temp base"),
      workspaceController: controller,
    });
    const authorization = createAuthorizedRuntimeExecution({
      policy,
      provider,
      authorizationNonce: "skill-read-only-runtime-e2e-v1",
    });
    const runtime = new LocalRuntime({ processManager: new LocalProcessManager() });
    try {
      const scope = await runtime.openWorkspace(
        { id: workspaceId, path: workspace },
        { processAuthorization: authorization },
      );
      for (const [label, currentResourceFile, grant, expectedContent] of [
        ["project", resourceFile, projectDecision.grant, frozenContent],
        ["user", externalResourceFile, userDecision.grant, "FROZEN_USER_SKILL_RESOURCE_V1\r\n"],
      ] as const) {
        const result = await scope.exec.executeArgvAuthorized({
          ownerRunId: policy.runId,
          executable:
            process.env.ComSpec ??
            join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
          args: ["/d", "/s", "/c", basename(probe), currentResourceFile, adjacentFile, label],
          workdir: ".",
          yieldTimeMs: 5_000,
          authorization,
          readOnlyResourceGrant: grant,
        });
        expect(result.status).toBe("EXITED");
        expect(result.exitCode).toBe(0);
        await expect(readFile(join(workspace, `${label}-resource-read.txt`), "utf8")).resolves.toBe(
          expectedContent,
        );
        await expect(
          access(join(workspace, `${label}-resource-read-failed.txt`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          access(join(workspace, `${label}-adjacent-readable.txt`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          access(join(workspace, `${label}-adjacent-denied.txt`)),
        ).resolves.toBeUndefined();
        await expect(
          access(join(workspace, `${label}-resource-write-ok.txt`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          access(join(workspace, `${label}-resource-write-denied.txt`)),
        ).resolves.toBeUndefined();
        await expect(readFile(currentResourceFile, "utf8")).resolves.toBe(expectedContent);
        await expect(
          readFile(join(workspace, `${label}-workspace-write.txt`), "utf8"),
        ).resolves.toBe("workspace-write-ok\r\n");
      }
      await expect(readdir(join(fixtureDirectory, "private temp base"))).resolves.toEqual([]);
      expect(await readFile(adjacentFile, "utf8")).toContain("ADJACENT_PRIVATE_CONTENT");
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects a resource grant outside the Run's immutable resource policy before spawning", async () => {
    const resourceIdentity = {
      resourceId: "binding_other_run",
      bundleRevision: "bundle_revision_other",
      canonicalRoot: resourceRoot.replaceAll("\\", "/"),
      contentManifestHash: "0".repeat(64),
    };
    const runId = "run_skill_grant_rejection" as never;
    const workspaceId = createWorkspaceId();
    const policy = createRuntimeProcessPolicy({
      runId,
      workspaceId,
      workspaceRoot: workspace,
      filesystemBoundary: "WORKSPACE_READ_WRITE",
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
      readOnlyResources: {
        runId,
        revision: "security_policy_empty",
        enabled: true,
        expiresAt: Date.now() + 30_000,
        resources: [],
      },
    });
    const provider = {
      id: "should-not-spawn",
      kind: "RESTRICTED" as const,
      enforcement: "HARD" as const,
      create: async () => {
        throw new Error("the provider must not be called for an unlisted resource");
      },
    };
    const authorization = createAuthorizedRuntimeExecution({
      policy,
      provider,
      authorizationNonce: "skill-grant-rejection-v1",
    });
    const runtime = new LocalRuntime();
    try {
      const scope = await runtime.openWorkspace(
        { id: workspaceId, path: workspace },
        { processAuthorization: authorization },
      );
      await expect(
        scope.exec.executeArgvAuthorized({
          ownerRunId: runId,
          executable: "cmd.exe",
          args: ["/c", "exit", "0"],
          workdir: ".",
          yieldTimeMs: 250,
          authorization,
          readOnlyResourceGrant: { ...resourceIdentity, runId } as never,
        }),
      ).rejects.toThrow(/resource|grant|authorization/i);
    } finally {
      await runtime.dispose();
    }
  });

  it("never falls back to an unrestricted process when a grant lacks Runtime authorization", async () => {
    const createProcess = vi.fn(async () => {
      throw new Error("a process must not be created");
    });
    const processManager = new LocalProcessManager({
      pipeFactory: { create: createProcess },
    });
    await expect(
      processManager.start({
        ownerRunId: "run_skill_unauthorized_grant" as never,
        command: "node",
        tty: false,
        yieldTimeMs: 250,
        cwd: workspace,
        env: process.env,
        launch: { executable: "node", args: ["-e", "process.exit(0)"] },
        readOnlyResourceGrant: { runId: "run_skill_unauthorized_grant" } as never,
      }),
    ).rejects.toBeInstanceOf(RuntimeAuthorizationError);
    expect(createProcess).not.toHaveBeenCalled();
    await processManager.dispose();
  });
});
