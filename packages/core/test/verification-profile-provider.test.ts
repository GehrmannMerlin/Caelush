import { describe, expect, it } from "vitest";

import {
  toVerificationProjectProfile,
  type CoreProjectProfile,
} from "../src/verification-profile-provider.js";

describe("Verification project intelligence boundary", () => {
  it("maps Coding project intelligence into the verification profile without losing evidence", () => {
    const profile: CoreProjectProfile = {
      ecosystems: ["TYPESCRIPT", "NODE"],
      packageManager: {
        name: "pnpm",
        source: "PACKAGE_MANAGER_FIELD",
      },
      tooling: [
        {
          name: "vitest",
          evidencePaths: ["package.json#scripts.test"],
        },
      ],
      isMonorepo: true,
      rootPackage: {
        relativePath: "",
        scripts: [{ name: "test", command: "vitest run" }],
      },
      activePackage: {
        relativePath: "apps/demo",
        scripts: [{ name: "build", command: "tsc" }],
      },
    };

    expect(toVerificationProjectProfile(profile)).toEqual({
      ecosystems: ["TYPESCRIPT", "NODE"],
      packageManager: { name: "pnpm", source: "PACKAGE_MANAGER_FIELD" },
      tooling: [{ name: "vitest", evidencePaths: ["package.json#scripts.test"] }],
      isMonorepo: true,
      rootPackage: {
        relativePath: ".",
        scripts: [{ name: "test", command: "vitest run" }],
      },
      activePackage: {
        relativePath: "apps/demo",
        scripts: [{ name: "build", command: "tsc" }],
      },
    });
  });
});
