import { expandPermissionPreset } from "@caelush/security";
import { describe, expect, it } from "vitest";
import { RunSecurityPromptProjector } from "../src/services/run-security-prompt-projector.js";

describe("RunSecurityPromptProjector", () => {
  it("projects the immutable policy and runtime facts as bounded synthetic context", () => {
    const policy = expandPermissionPreset({
      presetId: "FULL_ACCESS",
      expectedVersion: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const block = new RunSecurityPromptProjector().project(policy, {
      runtimeKind: "local",
      sandboxProvider: "unrestricted",
      enforcement: "NONE",
      ttySupported: false,
    });

    expect(block).toMatchObject({
      id: "agent.security-policy",
      sensitivity: "PUBLIC",
      source: "RUN_SECURITY_POLICY",
    });
    expect(block.text).toContain("FULL_ACCESS");
    expect(block.text).toContain("do not wait for approval");
    expect(block.text).toContain("hard safety denials");
    expect(block.text).toContain("opaque third-party binaries");
    expect(block.text).not.toContain("C:/");
    expect(block.text).not.toContain("D:/");
  });
});
