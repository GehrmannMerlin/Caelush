import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createReasoningResolver } from "../src/reasoning/reasoning-resolver.js";
import { modelDescriptor } from "./support/fixtures.js";
import type { ModelDescriptor } from "../src/models/model-descriptor.js";
import type { ReasoningLevel } from "../src/reasoning/reasoning-level.js";
import type { ReasoningResolutionPolicy } from "../src/reasoning/reasoning-resolution.js";

function model(supportedLevels: readonly ReasoningLevel[] | undefined): ModelDescriptor {
  if (supportedLevels === undefined) return modelDescriptor();
  return modelDescriptor({
    reasoning: { supportedLevels, supportsSummary: "SUPPORTED" },
  });
}

function resolve(
  supportedLevels: readonly ReasoningLevel[] | undefined,
  level: ReasoningLevel | undefined,
  policy: ReasoningResolutionPolicy = "PREFER_BUDGET",
): ReturnType<ReturnType<typeof createReasoningResolver>["resolve"]> {
  return createReasoningResolver().resolve({
    model: model(supportedLevels),
    policy,
    ...(level === undefined ? {} : { request: { level } }),
  });
}

describe("ReasoningResolver request absent", () => {
  it("reports NOT_REQUESTED with no effective level", () => {
    expect(resolve(["LOW", "HIGH"], undefined)).toEqual({
      mode: "NOT_REQUESTED",
      policy: "PREFER_BUDGET",
    });
    expect(resolve(undefined, undefined, "STRICT")).toEqual({
      mode: "NOT_REQUESTED",
      policy: "STRICT",
    });
  });
});

describe("ReasoningResolver PREFER_BUDGET", () => {
  it("resolves an exact level", () => {
    expect(resolve(["OFF", "LOW", "HIGH"], "OFF")).toEqual({
      requested: "OFF",
      effective: "OFF",
      mode: "EXACT",
      policy: "PREFER_BUDGET",
    });
    expect(resolve(["OFF", "LOW", "HIGH"], "HIGH")).toEqual({
      requested: "HIGH",
      effective: "HIGH",
      mode: "EXACT",
      policy: "PREFER_BUDGET",
    });
  });

  it("clamps down to the highest supported level at or below the request", () => {
    expect(resolve(["LOW", "MEDIUM"], "HIGH")).toEqual({
      requested: "HIGH",
      effective: "MEDIUM",
      mode: "CLAMPED_DOWN",
      policy: "PREFER_BUDGET",
    });
    expect(resolve(["OFF", "MINIMAL", "LOW"], "XHIGH")).toEqual({
      requested: "XHIGH",
      effective: "LOW",
      mode: "CLAMPED_DOWN",
      policy: "PREFER_BUDGET",
    });
  });

  it("clamps up to the lowest supported level above the request when nothing is below", () => {
    expect(resolve(["MEDIUM"], "LOW")).toEqual({
      requested: "LOW",
      effective: "MEDIUM",
      mode: "CLAMPED_UP",
      policy: "PREFER_BUDGET",
    });
    expect(resolve(["HIGH"], "OFF")).toEqual({
      requested: "OFF",
      effective: "HIGH",
      mode: "CLAMPED_UP",
      policy: "PREFER_BUDGET",
    });
  });

  it("is the default policy", () => {
    expect(resolve(["LOW"], "LOW").policy).toBe("PREFER_BUDGET");
  });
});

describe("ReasoningResolver STRICT", () => {
  it("accepts an exact supported level", () => {
    expect(resolve(["LOW", "HIGH"], "HIGH", "STRICT")).toEqual({
      requested: "HIGH",
      effective: "HIGH",
      mode: "EXACT",
      policy: "STRICT",
    });
  });

  it("rejects an unsupported level instead of clamping", () => {
    for (const level of ["XHIGH", "OFF"] as ReasoningLevel[]) {
      try {
        resolve(["LOW", "MEDIUM"], level, "STRICT");
        expect.unreachable("STRICT must reject an unsupported level");
      } catch (error) {
        expect(error).toBeInstanceOf(AIError);
        expect((error as AIError).code).toBe("AI_CAPABILITY_UNSUPPORTED");
        expect((error as AIError).retryable).toBe(false);
      }
    }
  });
});

describe("ReasoningResolver explicit request without a usable profile", () => {
  it("rejects an explicit request when the model has no reasoning profile", () => {
    for (const policy of ["PREFER_BUDGET", "STRICT"] as ReasoningResolutionPolicy[]) {
      try {
        resolve(undefined, "HIGH", policy);
        expect.unreachable("an explicit request without a profile must be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(AIError);
        expect((error as AIError).code).toBe("AI_CAPABILITY_UNSUPPORTED");
      }
    }
  });

  it("rejects an explicit request when the profile offers no levels", () => {
    for (const policy of ["PREFER_BUDGET", "STRICT"] as ReasoningResolutionPolicy[]) {
      expect(() => resolve([], "LOW", policy)).toThrow(AIError);
    }
  });

  it("rejects an explicit request when the model declares reasoning UNSUPPORTED", () => {
    const unsupported = modelDescriptor({
      capabilities: { ...modelDescriptor().capabilities, reasoning: "UNSUPPORTED" },
      reasoning: { supportedLevels: ["LOW"], supportsSummary: "UNSUPPORTED" },
    });

    try {
      createReasoningResolver().resolve({
        model: unsupported,
        policy: "PREFER_BUDGET",
        request: { level: "LOW" },
      });
      expect.unreachable("an UNSUPPORTED reasoning capability must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AIError);
      expect((error as AIError).code).toBe("AI_CAPABILITY_UNSUPPORTED");
      expect((error as AIError).model).toEqual(unsupported.ref);
    }
  });

  it("still allows no request at all for an UNSUPPORTED model", () => {
    const unsupported = modelDescriptor({
      capabilities: { ...modelDescriptor().capabilities, reasoning: "UNSUPPORTED" },
    });

    expect(
      createReasoningResolver().resolve({ model: unsupported, policy: "PREFER_BUDGET" }),
    ).toEqual({ mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" });
  });
});

describe("ReasoningResolver determinism", () => {
  it("makes the effective level observable and repeatable", () => {
    const resolver = createReasoningResolver();
    const input = {
      model: model(["LOW", "MEDIUM"]),
      policy: "PREFER_BUDGET" as const,
      request: { level: "HIGH" as const },
    };

    const first = resolver.resolve(input);
    const second = resolver.resolve(input);

    expect(first.effective).toBe("MEDIUM");
    expect(first).toEqual(second);
  });
});
