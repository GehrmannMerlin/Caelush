import { describe, expect, it } from "vitest";
import { DaemonInfoSchema } from "../src/index.js";

const legacyDaemonInfo = {
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

describe("optional Desktop Daemon capabilities", () => {
  it("continues to parse the original DaemonInfo without Desktop fields", () => {
    expect(DaemonInfoSchema.parse(legacyDaemonInfo)).toEqual(legacyDaemonInfo);
  });

  it("accepts only explicitly supported optional true capability declarations", () => {
    const info = {
      ...legacyDaemonInfo,
      capabilities: { ...legacyDaemonInfo.capabilities, desktopHostAuthV1: true },
    };
    expect(DaemonInfoSchema.parse(info).capabilities.desktopHostAuthV1).toBe(true);
    expect(
      DaemonInfoSchema.safeParse({
        ...legacyDaemonInfo,
        capabilities: { ...legacyDaemonInfo.capabilities, desktopHostAuthV1: false },
      }).success,
    ).toBe(false);
  });

  it("keeps strict rejection of unknown fields and Cloud identity metadata", () => {
    expect(
      DaemonInfoSchema.safeParse({ ...legacyDaemonInfo, userId: "not-a-daemon-field" }).success,
    ).toBe(false);
    expect(
      DaemonInfoSchema.safeParse({
        ...legacyDaemonInfo,
        capabilities: { ...legacyDaemonInfo.capabilities, unknownFutureCapability: true },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["Cloud userId", { userId: "00000000-0000-4000-8000-000000000001" }],
    ["Cloud deviceId", { deviceId: "00000000-0000-4000-8000-000000000002" }],
    ["Desktop product version", { desktopVersion: "0.1.0" }],
    ["update policy", { updatePolicy: { revision: 1 } }],
    ["Desktop panel state", { panelState: { browser: true, terminal: true } }],
  ])("rejects %s at the DaemonInfo handshake boundary", (_label, metadata) => {
    expect(DaemonInfoSchema.safeParse({ ...legacyDaemonInfo, ...metadata }).success).toBe(false);
  });
});
