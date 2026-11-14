import { describe, expect, it } from "vitest";
import type { SkillManifest } from "../src/index.js";

const domain = (await import("../src/index.js")) as unknown as Record<string, unknown>;

describe("Skill invocation policy", () => {
  it("defaults to allowing both model and user invocation", () => {
    const skill = manifest({});

    expect(canInvoke(skill, "MODEL")).toBe(true);
    expect(canInvoke(skill, "USER")).toBe(true);
  });

  it("keeps manual-only and automatic-only policies independent", () => {
    const manualOnly = manifest({ modelInvocable: false });
    const automaticOnly = manifest({ userInvocable: false });

    expect(canInvoke(manualOnly, "MODEL")).toBe(false);
    expect(canInvoke(manualOnly, "USER")).toBe(true);
    expect(canInvoke(automaticOnly, "MODEL")).toBe(true);
    expect(canInvoke(automaticOnly, "USER")).toBe(false);
  });
});

function manifest(overrides: Partial<SkillManifest>): SkillManifest {
  return {
    name: "policy-test",
    description: "Test invocation policy",
    body: "Body",
    userInvocable: true,
    modelInvocable: true,
    ...overrides,
  };
}

function canInvoke(manifestValue: SkillManifest, audience: "USER" | "MODEL"): boolean {
  const candidate = domain.isSkillInvocable;
  expect(candidate, "isSkillInvocable should be exported").toBeTypeOf("function");
  return (candidate as (skill: SkillManifest, mode: "USER" | "MODEL") => boolean)(
    manifestValue,
    audience,
  );
}
