import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sandboxRunnerModule from "./build-sandbox-runner.mjs";

type PrepareDevelopmentSandboxRunner = (options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly repositoryRoot: string;
  readonly homeDirectory?: string;
  readonly buildIfMissing?: boolean;
  readonly discover?: (options: Record<string, unknown>) => Promise<{
    readonly binaryPath: string;
    readonly manifestPath: string;
  }>;
  readonly build?: (options: Record<string, unknown>) => Promise<{
    readonly binaryPath: string;
    readonly manifestPath: string;
  }>;
}) => Promise<{
  readonly status: "CONFIGURED" | "EXPLICIT" | "SKIPPED" | "UNAVAILABLE";
  readonly reasonCode?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}>;

function developmentPreparer(): PrepareDevelopmentSandboxRunner {
  const prepare = (
    sandboxRunnerModule as typeof sandboxRunnerModule & {
      readonly prepareDevelopmentSandboxRunner?: PrepareDevelopmentSandboxRunner;
    }
  ).prepareDevelopmentSandboxRunner;
  expect(prepare).toBeTypeOf("function");
  return prepare!;
}

describe("development sandbox Runner preparation", () => {
  it("runs Cargo asynchronously so startup lease heartbeats can continue", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-development-runner-async-"));
    const builtBinary = join(root, "built-runner.exe");
    try {
      await writeFile(builtBinary, "verified runner", "utf8");
      let eventLoopAdvanced = false;
      const spawn = () => {
        const child = new EventEmitter();
        setTimeout(() => {
          eventLoopAdvanced = true;
          child.emit("exit", 0);
        }, 5);
        return child;
      };

      await sandboxRunnerModule.buildSandboxRunner({
        repositoryRoot: root,
        binaryPath: builtBinary,
        platform: "win32",
        arch: "x64",
        spawn,
      });

      expect(eventLoopAdvanced).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers only a manifest-bound development Runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-development-runner-"));
    const builtBinary = join(root, "built-runner.exe");
    try {
      await writeFile(builtBinary, "verified runner", "utf8");
      const built = await sandboxRunnerModule.buildSandboxRunner({
        repositoryRoot: root,
        binaryPath: builtBinary,
        runCargo: false,
        platform: "win32",
        arch: "x64",
      });
      const discovered = await sandboxRunnerModule.discoverDevelopmentSandboxRunner({
        repositoryRoot: root,
        platform: "win32",
        arch: "x64",
      });
      expect(discovered.binaryPath).toBe(built.binaryPath);
      expect(discovered.manifestPath).toBe(built.manifestPath);

      await writeFile(discovered.binaryPath, "tampered runner", "utf8");
      await expect(
        sandboxRunnerModule.discoverDevelopmentSandboxRunner({
          repositoryRoot: root,
          platform: "win32",
          arch: "x64",
        }),
      ).rejects.toThrow("SANDBOX_RUNNER_HASH_MISMATCH");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds and injects a verified Windows Runner without manual environment variables", async () => {
    const prepare = developmentPreparer();
    let built: { readonly binaryPath: string; readonly manifestPath: string } | undefined;
    const result = await prepare({
      environment: { CAELUSH_HOME: "C:/caelush-home" },
      platform: "win32",
      repositoryRoot: "C:/repo",
      build: async (options) => {
        const outputDirectory = String(options.outputDirectory);
        built = {
          binaryPath: join(outputDirectory, "caelush-sandbox-runner.exe"),
          manifestPath: join(outputDirectory, "manifest.json"),
        };
        return built;
      },
    });

    expect(result).toEqual({
      status: "CONFIGURED",
      environment: {
        CAELUSH_HOME: "C:/caelush-home",
        CAELUSH_SANDBOX_RUNNER_PATH: built!.binaryPath,
        CAELUSH_SANDBOX_RUNNER_MANIFEST: built!.manifestPath,
      },
    });
  });

  it("keeps the development Runner outside the repository it may sandbox", async () => {
    const prepare = developmentPreparer();
    const repositoryRoot = await mkdtemp(join(tmpdir(), "caelush-runner-workspace-"));
    const caelushHome = await mkdtemp(join(tmpdir(), "caelush-runner-home-"));
    let outputDirectory: string | undefined;
    try {
      const result = await prepare({
        environment: { CAELUSH_HOME: caelushHome },
        platform: "win32",
        repositoryRoot,
        build: async (options) => {
          outputDirectory = String(options.outputDirectory);
          return {
            binaryPath: join(outputDirectory, "caelush-sandbox-runner.exe"),
            manifestPath: join(outputDirectory, "manifest.json"),
          };
        },
      });

      expect(result.status).toBe("CONFIGURED");
      expect(outputDirectory).toBeDefined();
      expect(outputDirectory).toBe(join(caelushHome, "runtime", "sandbox-runner", "windows-x64"));
      const relativeToRepository = relative(repositoryRoot, outputDirectory!);
      expect(
        relativeToRepository === "" ||
          (!relativeToRepository.startsWith("..") && !isAbsolute(relativeToRepository)),
      ).toBe(false);
      const relativeToHome = relative(caelushHome, outputDirectory!);
      expect(relativeToHome.startsWith("..") || isAbsolute(relativeToHome)).toBe(false);
      expect(result.environment.CAELUSH_SANDBOX_RUNNER_PATH).toBe(
        join(outputDirectory!, "caelush-sandbox-runner.exe"),
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(caelushHome, { recursive: true, force: true });
    }
  });

  it("uses the user product home when CAELUSH_HOME is not configured", async () => {
    const prepare = developmentPreparer();
    const repositoryRoot = await mkdtemp(join(tmpdir(), "caelush-runner-default-workspace-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "caelush-runner-default-home-"));
    let outputDirectory: string | undefined;
    try {
      const result = await prepare({
        environment: {},
        platform: "win32",
        repositoryRoot,
        homeDirectory,
        build: async (options) => {
          outputDirectory = String(options.outputDirectory);
          return {
            binaryPath: join(outputDirectory, "caelush-sandbox-runner.exe"),
            manifestPath: join(outputDirectory, "manifest.json"),
          };
        },
      });

      expect(result.status).toBe("CONFIGURED");
      expect(outputDirectory).toBe(
        join(homeDirectory, ".caelush", "runtime", "sandbox-runner", "windows-x64"),
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("preserves an explicit development override without rebuilding", async () => {
    const prepare = developmentPreparer();
    const environment = {
      CAELUSH_SANDBOX_RUNNER_PATH: "C:/custom/runner.exe",
      CAELUSH_SANDBOX_RUNNER_MANIFEST: "C:/custom/manifest.json",
    } as const;
    const result = await prepare({
      environment,
      platform: "win32",
      repositoryRoot: "C:/repo",
      build: async () => {
        throw new Error("an explicit override must not trigger a build");
      },
    });

    expect(result).toEqual({ status: "EXPLICIT", environment });
  });

  it("rejects an explicit Runner located inside the repository it may sandbox", async () => {
    const prepare = developmentPreparer();
    const repositoryRoot = await mkdtemp(join(tmpdir(), "caelush-runner-overlap-"));
    const environment = {
      CAELUSH_HOME: await mkdtemp(join(tmpdir(), "caelush-runner-overlap-home-")),
      CAELUSH_SANDBOX_RUNNER_PATH: join(
        repositoryRoot,
        "release-artifacts",
        "sandbox",
        "caelush-sandbox-runner.exe",
      ),
      CAELUSH_SANDBOX_RUNNER_MANIFEST: join(
        repositoryRoot,
        "release-artifacts",
        "sandbox",
        "manifest.json",
      ),
    } as const;
    try {
      const result = await prepare({
        environment,
        platform: "win32",
        repositoryRoot,
        build: async () => {
          throw new Error("an overlapping explicit override must not trigger a build");
        },
      });

      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "RUNNER_INSIDE_WORKSPACE",
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(environment.CAELUSH_HOME, { recursive: true, force: true });
    }
  });

  it("does not build when CAELUSH_HOME would place the Runner inside the repository", async () => {
    const prepare = developmentPreparer();
    const repositoryRoot = await mkdtemp(join(tmpdir(), "caelush-runner-home-overlap-"));
    const build = vi.fn(async () => ({
      binaryPath: join(repositoryRoot, ".caelush", "runner.exe"),
      manifestPath: join(repositoryRoot, ".caelush", "manifest.json"),
    }));
    try {
      const result = await prepare({
        environment: { CAELUSH_HOME: join(repositoryRoot, ".caelush") },
        platform: "win32",
        repositoryRoot,
        build,
      });

      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "RUNNER_INSIDE_WORKSPACE",
      });
      expect(build).not.toHaveBeenCalled();
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a CAELUSH_HOME link that resolves back inside the repository", async () => {
    const prepare = developmentPreparer();
    const repositoryRoot = await mkdtemp(join(tmpdir(), "caelush-runner-linked-repository-"));
    const linkParent = await mkdtemp(join(tmpdir(), "caelush-runner-linked-home-"));
    const linkedTarget = join(repositoryRoot, ".caelush");
    const linkedHome = join(linkParent, "home-link");
    const build = vi.fn(async () => ({
      binaryPath: join(linkedHome, "runtime", "runner.exe"),
      manifestPath: join(linkedHome, "runtime", "manifest.json"),
    }));
    try {
      await mkdir(linkedTarget, { recursive: true });
      await symlink(linkedTarget, linkedHome, process.platform === "win32" ? "junction" : "dir");
      const result = await prepare({
        environment: { CAELUSH_HOME: linkedHome },
        platform: "win32",
        repositoryRoot,
        build,
      });

      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "RUNNER_INSIDE_WORKSPACE",
      });
      expect(build).not.toHaveBeenCalled();
    } finally {
      await rm(linkParent, { recursive: true, force: true });
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("loads an existing verified Runner for doctor without invoking Cargo", async () => {
    const prepare = developmentPreparer();
    let discovered: { readonly binaryPath: string; readonly manifestPath: string } | undefined;
    const result = await prepare({
      environment: { CAELUSH_HOME: "C:/caelush-home" },
      platform: "win32",
      repositoryRoot: "C:/repo",
      buildIfMissing: false,
      discover: async (options) => {
        const outputDirectory = String(options.outputDirectory);
        discovered = {
          binaryPath: join(outputDirectory, "caelush-sandbox-runner.exe"),
          manifestPath: join(outputDirectory, "manifest.json"),
        };
        return discovered;
      },
      build: async () => {
        throw new Error("doctor must not invoke Cargo");
      },
    });

    expect(result.status).toBe("CONFIGURED");
    expect(result.environment.CAELUSH_SANDBOX_RUNNER_PATH).toBe(discovered!.binaryPath);
  });

  it("keeps the daemon startable and restricted presets unavailable when the build fails", async () => {
    const prepare = developmentPreparer();
    const environment = { CAELUSH_HOME: "C:/caelush-home" } as const;
    const result = await prepare({
      environment,
      platform: "win32",
      repositoryRoot: "C:/repo",
      build: async () => {
        throw new Error("cargo unavailable");
      },
    });

    expect(result).toEqual({ status: "UNAVAILABLE", environment });
  });
});
import { EventEmitter } from "node:events";
