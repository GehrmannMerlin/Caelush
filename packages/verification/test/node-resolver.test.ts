import {
  createVerificationCheckId,
  createVerificationPlanId,
  type VerificationCheck,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { nodeProjectCheckResolver, type VerificationProjectProfile } from "../src/index.js";

function check(purpose: "LINT" | "TYPECHECK" | "TEST" | "BUILD"): VerificationCheck {
  return {
    id: createVerificationCheckId(),
    planId: createVerificationPlanId(),
    ordinal: 0,
    stage: "FAST_STATIC",
    requirement: "IF_AVAILABLE",
    spec: { kind: "PROJECT", purpose, source: "SYSTEM" },
    status: "PENDING",
    createdAt: 1_700_000_000_000,
  };
}

function profile(overrides: Partial<VerificationProjectProfile> = {}): VerificationProjectProfile {
  return {
    ecosystems: ["NODE"],
    packageManager: { name: "pnpm", source: "pnpm-lock.yaml" },
    tooling: [],
    isMonorepo: false,
    rootPackage: {
      relativePath: ".",
      scripts: [
        { name: "pretest", command: "echo pre" },
        { name: "test", command: "vitest run" },
        { name: "posttest", command: "echo post" },
        { name: "lint", command: "eslint ." },
        { name: "type-check", command: "tsc --noEmit" },
        { name: "build", command: "tsc -b" },
      ],
    },
    ...overrides,
  };
}

describe("Node project verification resolver", () => {
  it.each([
    ["pnpm", "pnpm"],
    ["npm", "npm"],
    ["yarn", "yarn"],
    ["bun", "bun"],
  ] as const)("maps %s to an explicit run argv", (manager, executable) => {
    const result = nodeProjectCheckResolver.resolve(
      check("TEST"),
      profile({ packageManager: { name: manager } }),
    );
    expect(result.kind).toBe("READY");
    if (result.kind !== "READY") return;
    expect(result.candidate.executable).toBe(executable);
    expect(result.candidate.args).toEqual(["run", "test"]);
  });

  it("uses root exact scripts before active package fallback", () => {
    const result = nodeProjectCheckResolver.resolve(
      check("TEST"),
      profile({
        isMonorepo: true,
        activePackage: {
          relativePath: "packages/app",
          scripts: [{ name: "test", command: "app-test" }],
        },
      }),
    );
    expect(result.kind).toBe("READY");
    if (result.kind !== "READY") return;
    expect(result.candidate.workdir).toBe(".");
    expect(result.candidate.provenance.evidencePath).toBe("package.json");
    expect(result.candidate.securityInputs.map((item) => item.label)).toEqual([
      "pretest",
      "test",
      "posttest",
    ]);
  });

  it("falls back to the active package only when root lacks the exact alias", () => {
    const result = nodeProjectCheckResolver.resolve(
      check("TYPECHECK"),
      profile({
        rootPackage: {
          relativePath: ".",
          scripts: [{ name: "type-check", command: "root-check" }],
        },
        activePackage: {
          relativePath: "packages/app",
          scripts: [{ name: "typecheck", command: "app-check" }],
        },
      }),
    );
    expect(result.kind).toBe("READY");
    if (result.kind !== "READY") return;
    expect(result.candidate.workdir).toBe("packages/app");
    expect(result.candidate.provenance.scriptName).toBe("typecheck");
  });

  it("accepts only the explicit typecheck fallback and rejects fuzzy aliases", () => {
    const fallback = nodeProjectCheckResolver.resolve(
      check("TYPECHECK"),
      profile({
        rootPackage: { relativePath: ".", scripts: [{ name: "type-check", command: "tsc" }] },
      }),
    );
    expect(fallback.kind).toBe("READY");

    const fuzzy = nodeProjectCheckResolver.resolve(
      check("LINT"),
      profile({
        rootPackage: { relativePath: ".", scripts: [{ name: "lint:fix", command: "eslint" }] },
      }),
    );
    expect(fuzzy).toEqual({ kind: "UNAVAILABLE", reason: "MISSING_SCRIPT" });
  });

  it("returns bounded unavailable reasons and never invents installer commands", () => {
    const unknown = nodeProjectCheckResolver.resolve(
      check("TEST"),
      profile({ packageManager: { name: "UNKNOWN" } }),
    );
    expect(unknown).toEqual({ kind: "UNAVAILABLE", reason: "UNKNOWN_PACKAGE_MANAGER" });

    const missing = nodeProjectCheckResolver.resolve(
      check("BUILD"),
      profile({ rootPackage: { relativePath: ".", scripts: [] } }),
    );
    expect(missing).toEqual({ kind: "UNAVAILABLE", reason: "MISSING_SCRIPT" });

    const candidate = nodeProjectCheckResolver.resolve(check("TEST"), profile());
    expect(JSON.stringify(candidate)).not.toMatch(/npx|pnpx|dlx|bunx|install|fetch|sync/i);
  });
});
