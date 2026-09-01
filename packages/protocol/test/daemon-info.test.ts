import { DaemonInfoSchema, DefaultRunConfigurationSchema } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const defaults = {
  runtime: { id: "local", kind: "local" },
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
} as const;

describe("Phase 12B daemon defaults", () => {
  it("parses the public V1 default Run configuration", () => {
    expect(DefaultRunConfigurationSchema.parse(defaults)).toEqual(defaults);
  });

  it("rejects extra public default configuration fields", () => {
    expect(() =>
      DefaultRunConfigurationSchema.parse({ ...defaults, endpoint: "secret" }),
    ).toThrow();
  });

  it("requires the default Run configuration in DaemonInfo", () => {
    const info = {
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
      configuredProviders: ["fixture"],
      defaultModel: { provider: "fixture", model: "fixture-model" },
      defaultRunConfiguration: defaults,
    } as const;

    expect(DaemonInfoSchema.parse(info).defaultRunConfiguration).toEqual(defaults);
    expect(
      DaemonInfoSchema.safeParse({ ...info, defaultRunConfiguration: undefined }).success,
    ).toBe(false);
  });
});
