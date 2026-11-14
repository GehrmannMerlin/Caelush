import { describe, expect, it } from "vitest";
import { toApiErrorResponse } from "../src/transport/error-handler.js";

const daemon = (await import("../src/index.js")) as unknown as Record<string, unknown>;

interface SkillCapabilities {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly catalog: boolean;
  readonly invocation: boolean;
  readonly scriptExecution: boolean;
  readonly presentationVersion: 4 | null;
}

interface SkillFeatureReadiness {
  readonly enabled: boolean;
  readonly catalogReady: boolean;
  readonly invocationReady: boolean;
  readonly scriptExecutionReady: boolean;
  readonly presentationReady: boolean;
}

describe("Skills V1 default-off feature policy", () => {
  it("keeps production capability defaults fully OFF", () => {
    const capabilities = call<SkillCapabilities>("createSkillCapabilityResponse");

    expect(capabilities).toEqual({
      schemaVersion: 1,
      enabled: false,
      catalog: false,
      invocation: false,
      scriptExecution: false,
      presentationVersion: null,
    });
  });

  it("defaults the master switch OFF and fails closed on invalid values", () => {
    const resolveEnabled = exportedFunction("resolveSkillFeatureEnabled") as (
      environment: Readonly<Record<string, string | undefined>>,
    ) => boolean;
    expect(resolveEnabled({})).toBe(false);
    expect(resolveEnabled({ CAELUSH_FEATURE_SKILLS_V1: "on" })).toBe(true);
    expect(resolveEnabled({ CAELUSH_FEATURE_SKILLS_V1: "sometimes" })).toBe(false);
  });

  it("derives advertised features from the master switch and component readiness", () => {
    const ready: SkillFeatureReadiness = {
      enabled: true,
      catalogReady: true,
      invocationReady: true,
      scriptExecutionReady: true,
      presentationReady: true,
    };
    const disabled = { ...ready, enabled: false, presentationReady: false };
    const incomplete = { ...ready, invocationReady: false };

    expect(call<SkillCapabilities>("createSkillCapabilityResponse", ready)).toEqual({
      schemaVersion: 1,
      enabled: true,
      catalog: true,
      invocation: true,
      scriptExecution: true,
      presentationVersion: 4,
    });
    expect(call<SkillCapabilities>("createSkillCapabilityResponse", disabled)).toMatchObject({
      enabled: false,
      catalog: false,
      invocation: false,
      scriptExecution: false,
      presentationVersion: null,
    });
    expect(call<SkillCapabilities>("createSkillCapabilityResponse", incomplete)).toMatchObject({
      enabled: true,
      catalog: true,
      invocation: false,
      scriptExecution: false,
    });
  });

  it("rejects a new feature request with a safe SKILLS_UNAVAILABLE reason while OFF", () => {
    const capabilities = call<SkillCapabilities>("createSkillCapabilityResponse");
    const assertAvailable = exportedFunction("assertSkillCapabilityAvailable");
    let thrown: unknown;
    try {
      assertAvailable(capabilities, "catalog");
    } catch (error) {
      thrown = error;
    }

    const mapped = toApiErrorResponse(thrown, "req-skill-off");
    expect(mapped.statusCode).toBe(503);
    expect(mapped.body.error.code).toBe("LOCAL_AGENT_UNAVAILABLE");
    expect(mapped.body.error.details).toEqual({ reason: "SKILLS_UNAVAILABLE" });
    expect(JSON.stringify(mapped.body)).not.toMatch(/C:\\|secret|Error:/);
  });
});

function call<TResult>(name: string, ...input: readonly unknown[]): TResult {
  return exportedFunction(name)(...input) as TResult;
}

function exportedFunction(name: string): (...input: readonly unknown[]) => unknown {
  const candidate = daemon[name];
  expect(candidate, `${name} should be exported`).toBeTypeOf("function");
  return candidate as (...input: readonly unknown[]) => unknown;
}
