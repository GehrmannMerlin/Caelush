import { describe, expect, it } from "vitest";
import type { ProcessSandboxProvider, ProcessSandboxProbe } from "../src/index.js";
import { RuntimeSandboxError } from "../src/index.js";
import { createRuntimeProcessPolicy, selectProcessSandbox } from "../src/index.js";

const provider = (
  id: string,
  kind: "RESTRICTED" | "UNRESTRICTED",
  enforcement: "HARD" | "PARTIAL" | "NONE",
): ProcessSandboxProvider => ({
  id,
  kind,
  enforcement,
  create: async () => {
    throw new Error("test provider does not spawn");
  },
});

const restrictedPolicy = () =>
  createRuntimeProcessPolicy({
    runId: "run_provider_restricted" as never,
    workspaceId: "workspace_provider" as never,
    workspaceRoot: "C:\\workspaces\\demo",
    filesystemBoundary: "WORKSPACE_READ_WRITE",
    processBoundary: "WORKSPACE_WRITE",
    requiredEnforcement: "OS_RESTRICTED",
  });

describe("Runtime process sandbox selection", () => {
  it("selects an explicit unrestricted provider only for Full Access policy", () => {
    const policy = createRuntimeProcessPolicy({
      runId: "run_provider_full" as never,
      workspaceId: "workspace_provider" as never,
      workspaceRoot: "C:\\workspaces\\demo",
      filesystemBoundary: "HOST_USER_SCOPE",
      processBoundary: "UNRESTRICTED",
      requiredEnforcement: "HARD_SAFETY_ONLY",
    });

    expect(selectProcessSandbox(policy, []).kind).toBe("UNRESTRICTED");
  });

  it("chooses an available restricted provider and never falls back to unrestricted", () => {
    const restricted = provider("windows-partial", "RESTRICTED", "PARTIAL");
    const probe: ProcessSandboxProbe = {
      provider: restricted,
      available: true,
      enforcement: "PARTIAL",
    };
    expect(selectProcessSandbox(restrictedPolicy(), [probe])).toBe(restricted);

    const unrestricted = provider("unrestricted", "UNRESTRICTED", "NONE");
    expect(() =>
      selectProcessSandbox(restrictedPolicy(), [
        { provider: unrestricted, available: true, enforcement: "NONE" },
      ]),
    ).toThrowError(RuntimeSandboxError);
  });

  it("fails closed when the required restricted provider is unavailable", () => {
    const restricted = provider("missing", "RESTRICTED", "NONE");
    expect(() =>
      selectProcessSandbox(restrictedPolicy(), [
        { provider: restricted, available: false, enforcement: "NONE", reasonCode: "PROBE_FAILED" },
      ]),
    ).toThrowError(RuntimeSandboxError);
  });
});
