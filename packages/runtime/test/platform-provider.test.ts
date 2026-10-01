import { describe, expect, it } from "vitest";
import {
  createLinuxBubblewrapProvider,
  createLinuxLandlockProvider,
  createMacSeatbeltProvider,
  createWindowsAclRestrictedTokenProvider,
} from "../src/index.js";
import type { ManagedProcessAdapter, SandboxedSpawnSpec } from "../src/index.js";

const fakeAdapter = (): ManagedProcessAdapter => ({
  tty: false,
  onStart: () => () => undefined,
  onOutput: () => () => undefined,
  onExit: () => () => undefined,
  onError: () => () => undefined,
  write: async () => undefined,
  close: async () => undefined,
});

const spec = (): SandboxedSpawnSpec => ({
  launch: { executable: "node", args: ["-e", "process.stdout.write('ok')"] },
  cwd: "C:\\workspace",
  env: { PATH: "C:\\Windows\\System32" },
  tty: false,
  authorizationNonce: "platform-provider-nonce-1",
  policy: {
    runId: "run_platform_provider" as never,
    filesystem: {
      workspaceId: "workspace_platform" as never,
      workspaceRoot: "C:\\workspace",
      hostUserRoot: "C:\\workspace",
      boundary: "WORKSPACE_READ_WRITE",
      protectedRoots: ["C:\\workspace"],
    },
    processBoundary: "WORKSPACE_WRITE",
    requiredEnforcement: "OS_RESTRICTED",
  },
});

describe("platform process sandbox Providers", () => {
  it("reports restricted capability without silently ordinary-spawning when the native runner is absent", async () => {
    const providers = [
      createWindowsAclRestrictedTokenProvider({ platform: "win32" }),
      createLinuxLandlockProvider({ platform: "linux" }),
      createLinuxBubblewrapProvider({ platform: "linux" }),
      createMacSeatbeltProvider({ platform: "darwin" }),
    ];
    for (const provider of providers) {
      expect(provider.kind).toBe("RESTRICTED");
      await expect(provider.create(spec())).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
      await expect(provider.probe!()).resolves.toMatchObject({ available: false });
    }
  });

  it("accepts an injected conformance adapter only through the restricted Provider seam", async () => {
    let observed: SandboxedSpawnSpec | undefined;
    const provider = createWindowsAclRestrictedTokenProvider({
      platform: "win32",
      adapterFactory: async (input) => {
        observed = input;
        return fakeAdapter();
      },
    });
    await expect(provider.create(spec())).resolves.toBeDefined();
    expect(observed?.policy.processBoundary).toBe("WORKSPACE_WRITE");
    await expect(provider.probe!()).resolves.toMatchObject({
      available: true,
      enforcement: "PARTIAL",
    });
  });

  it("does not expose TTY as supported until the provider has an explicit adapter", async () => {
    const provider = createLinuxLandlockProvider({
      platform: "linux",
      adapterFactory: async () => fakeAdapter(),
    });
    await expect(provider.create({ ...spec(), tty: true })).rejects.toMatchObject({
      code: "PTY_UNAVAILABLE",
    });
  });
});
