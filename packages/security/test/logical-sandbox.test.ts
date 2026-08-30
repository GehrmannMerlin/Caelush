import { describe, expect, it } from "vitest";
import { evaluateLogicalSandboxAdmission } from "../src/index.js";

describe("V1 logical sandbox admission", () => {
  it("admits structured local tools", () => {
    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "local",
        runtimeRequirements: { runtimeKinds: ["local"] },
        requiredCapabilities: ["FS_READ"],
        securityFacts: { resourceAccesses: [], secretScanInputs: [] },
      }),
    ).toEqual({ kind: "ALLOW", containment: "STRUCTURED_WORKSPACE" });
  });

  it("admits unconfined local processes only as an explicit non-OS-isolated boundary", () => {
    expect(
      evaluateLogicalSandboxAdmission({
        containment: "UNCONFINED_LOCAL_PROCESS",
        runtimeKind: "local",
        runtimeRequirements: { runtimeKinds: ["local"] },
        requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
        securityFacts: { resourceAccesses: [], secretScanInputs: [] },
      }),
    ).toEqual({ kind: "ALLOW", containment: "UNCONFINED_LOCAL_PROCESS" });
  });

  it("fails closed when runtime kind or security facts do not match", () => {
    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "remote",
        runtimeRequirements: { runtimeKinds: ["local"] },
        requiredCapabilities: ["FS_READ"],
        securityFacts: { resourceAccesses: [], secretScanInputs: [] },
      }),
    ).toMatchObject({ kind: "DENY", reasonCode: "RUNTIME_KIND_UNSUPPORTED" });

    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "local",
        runtimeRequirements: { runtimeKinds: ["local"] },
        requiredCapabilities: ["FS_READ"],
        securityFacts: undefined,
      }),
    ).toMatchObject({ kind: "DENY", reasonCode: "SECURITY_FACTS_UNAVAILABLE" });
  });
});
