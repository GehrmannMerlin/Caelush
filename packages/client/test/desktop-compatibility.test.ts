import { describe, expect, it } from "vitest";
import {
  DESKTOP_DAEMON_API_VERSION,
  DESKTOP_DAEMON_PROTOCOL_VERSION,
  evaluateDesktopDaemonCompatibility,
  type DesktopCompatibilityRequirements,
} from "../src/index.js";

const daemonInfo = {
  apiVersion: "v1",
  protocolVersion: 1,
  daemonVersion: "0.1.0",
  capabilities: {
    runExecution: true,
    runRecovery: true,
    cancellation: true,
    approvals: true,
    sseReplay: true,
  },
  runtimeKinds: ["local"],
  configuredProviders: [],
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  },
} as const;

function requirements(
  overrides: Partial<DesktopCompatibilityRequirements> = {},
): DesktopCompatibilityRequirements {
  return {
    productVersion: "0.1.0",
    apiVersion: DESKTOP_DAEMON_API_VERSION,
    protocolVersion: DESKTOP_DAEMON_PROTOCOL_VERSION,
    requiredCapabilities: ["runExecution", "sseReplay"],
    hostIdentityVerified: true,
    ...overrides,
  };
}

describe("Desktop Daemon compatibility evaluator", () => {
  it("accepts the exact controlled release tuple and required capabilities", () => {
    expect(evaluateDesktopDaemonCompatibility(daemonInfo, requirements())).toEqual({
      status: "COMPATIBLE",
      canEnterWorkspace: true,
      availableOptionalCapabilities: [],
      unavailableOptionalCapabilities: [],
    });
  });

  it("does not treat matching versions as proof of host identity", () => {
    const result = evaluateDesktopDaemonCompatibility(
      daemonInfo,
      requirements({ hostIdentityVerified: false }),
    );
    expect(result).toMatchObject({
      status: "INCOMPATIBLE",
      canEnterWorkspace: false,
      code: "HOST_IDENTITY_UNVERIFIED",
    });
  });

  it.each([
    [{ apiVersion: "v2" }, { code: "DAEMON_API_INCOMPATIBLE" }],
    [{ protocolVersion: 2 }, { code: "DAEMON_PROTOCOL_INCOMPATIBLE" }],
    [{ daemonVersion: "0.2.0" }, { code: "DAEMON_PRODUCT_VERSION_INCOMPATIBLE" }],
    [{ daemonVersion: "not-semver" }, { code: "DAEMON_PRODUCT_VERSION_INVALID" }],
  ])("fails closed for incompatible version metadata", (patch, expected) => {
    const result = evaluateDesktopDaemonCompatibility({ ...daemonInfo, ...patch }, requirements());
    expect(result).toMatchObject({ status: "INCOMPATIBLE", canEnterWorkspace: false, ...expected });
  });

  it("reports missing required capabilities and allows optional capability degradation", () => {
    const missingRequired = evaluateDesktopDaemonCompatibility(
      daemonInfo,
      requirements({ requiredCapabilities: ["sessionTranscript"] }),
    );
    expect(missingRequired).toMatchObject({
      status: "INCOMPATIBLE",
      code: "DAEMON_CAPABILITY_MISSING",
      missingCapabilities: ["sessionTranscript"],
    });

    expect(
      evaluateDesktopDaemonCompatibility(
        daemonInfo,
        requirements({ optionalCapabilities: ["sessionTranscript"] }),
      ),
    ).toMatchObject({
      status: "COMPATIBLE",
      unavailableOptionalCapabilities: ["sessionTranscript"],
    });
  });

  it("accepts Desktop security capabilities only when the trusted host requires them", () => {
    const daemonClaimsCapability = {
      ...daemonInfo,
      capabilities: {
        ...daemonInfo.capabilities,
        desktopHostAuthV1: true,
        desktopProfileBindingV1: true,
        desktopLocalProxyV1: true,
      },
    };
    const result = evaluateDesktopDaemonCompatibility(
      daemonClaimsCapability,
      requirements({
        requiredCapabilities: [
          "desktopHostAuthV1",
          "desktopProfileBindingV1",
          "desktopLocalProxyV1",
        ],
      }),
    );
    expect(result).toMatchObject({
      status: "COMPATIBLE",
      canEnterWorkspace: true,
    });

    const { desktopLocalProxyV1: _omitted, ...withoutProxy } = daemonClaimsCapability.capabilities;
    const missing = evaluateDesktopDaemonCompatibility(
      { ...daemonClaimsCapability, capabilities: withoutProxy },
      requirements({ requiredCapabilities: ["desktopLocalProxyV1"] }),
    );
    expect(missing).toMatchObject({ status: "INCOMPATIBLE", code: "DAEMON_CAPABILITY_MISSING" });
  });

  it("returns a safe invalid-info result for strict-schema violations", () => {
    const result = evaluateDesktopDaemonCompatibility(
      { ...daemonInfo, userId: "account-secret" },
      requirements(),
    );
    expect(result).toMatchObject({
      status: "INCOMPATIBLE",
      canEnterWorkspace: false,
      code: "DAEMON_INFO_INVALID",
    });
    expect(JSON.stringify(result)).not.toContain("account-secret");
  });
});
