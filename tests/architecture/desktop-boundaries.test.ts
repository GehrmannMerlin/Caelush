import { unlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureWorkspace, v2WorkspaceSpec } from "./support/fixture-workspace.js";
import { boundaries, scanner } from "./support/architecture-checker.js";

const openFixtures: Awaited<ReturnType<typeof createFixtureWorkspace>>[] = [];

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function desktopFixture(
  input: {
    readonly source?: string;
    readonly dependencies?: Record<string, string>;
  } = {},
): Promise<Awaited<ReturnType<typeof createFixtureWorkspace>>> {
  const source = input.source ?? 'import "@caelush/protocol";\nimport "@caelush/client";\n';
  const fixture = await createFixtureWorkspace(
    v2WorkspaceSpec({
      "apps/desktop": {
        source: { "index.ts": source },
        ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
      },
    }),
  );
  openFixtures.push(fixture);
  return fixture;
}

describe("Desktop architecture boundary", () => {
  it("scans non-empty Desktop source without requiring a placeholder workspace manifest", async () => {
    const fixture = await desktopFixture();
    await unlink(fixture.projectPath("apps/desktop/package.json"));

    const scan = await scanner.scanDesktopBoundary(fixture.root);

    expect(scan.policyVersion).toBe(1);
    expect(scan.sourceFileCount).toBe(1);
    expect(scan.sourceImportCount).toBe(2);
    expect(scan.violations).toEqual([]);
  });

  it("allows the public Protocol and client package entry points", async () => {
    const fixture = await desktopFixture({
      source: [
        'import "@caelush/protocol";',
        'import "@caelush/client";',
        'import { randomBytes } from "node:crypto";',
        'import { app } from "electron";',
      ].join("\n"),
    });

    const scan = await scanner.scanDesktopBoundary(fixture.root);

    expect(scan.sourceFileCount).toBeGreaterThan(0);
    expect(scan.sourceImportCount).toBe(4);
    expect(scan.violations).toEqual([]);
  });

  it("rejects all listed Agent implementation packages through static and dynamic imports", async () => {
    const forbiddenPackages = [
      "@caelush/agent",
      "@caelush/core",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/ai",
      "@caelush/coding-agent",
      "@caelush/verification",
    ];
    const source = [
      ...forbiddenPackages.map(
        (specifier, index) => `import * as dependency${index} from "${specifier}";`,
      ),
      'void import("@caelush/agent/dynamic");',
      'const requiredRuntime = require("@caelush/runtime");',
    ].join("\n");
    const fixture = await desktopFixture({ source });

    const scan = await scanner.scanDesktopBoundary(fixture.root);

    expect(scan.violations.map(({ specifier }) => specifier)).toEqual([
      ...forbiddenPackages,
      "@caelush/agent/dynamic",
      "@caelush/runtime",
    ]);
    expect(
      scan.violations.every(({ rule }) => rule === "DESKTOP_MUST_USE_APPROVED_WORKSPACE_PACKAGES"),
    ).toBe(true);
  });

  it("rejects a private package subpath and a relative path into package source", async () => {
    const fixture = await desktopFixture({
      source: [
        'import { CaelushClient } from "@caelush/client/src/client.js";',
        'import { LocalRuntime } from "../../../packages/runtime/src/index.js";',
      ].join("\n"),
    });

    const scan = await scanner.scanDesktopBoundary(fixture.root);

    expect(scan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "DESKTOP_MUST_USE_PUBLIC_PACKAGE_ENTRY_POINTS",
          specifier: "@caelush/client/src/client.js",
        }),
        expect.objectContaining({
          rule: "DESKTOP_MUST_NOT_IMPORT_OTHER_PROJECTS_BY_RELATIVE_PATH",
          specifier: "../../../packages/runtime/src/index.js",
        }),
      ]),
    );
  });

  it("rejects forbidden workspace dependencies declared in Desktop's manifest", async () => {
    const fixture = await desktopFixture({
      dependencies: {
        "@caelush/protocol": "workspace:*",
        "@caelush/client": "workspace:*",
        "@caelush/agent": "workspace:*",
      },
    });

    const scan = await scanner.scanDesktopBoundary(fixture.root);

    expect(scan.violations).toEqual([
      expect.objectContaining({
        rule: "DESKTOP_MUST_USE_APPROVED_WORKSPACE_PACKAGES",
        kind: "package-manifest",
        specifier: "@caelush/agent",
      }),
    ]);
  });

  it("fails through the existing architecture checker when a Desktop boundary is violated", async () => {
    const fixture = await desktopFixture({ source: 'import "@caelush/agent";\n' });

    const result = await boundaries.runBoundaryCheck({ root: fixture.root });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Desktop architecture boundary FAIL");
    expect(result.output).toContain("DESKTOP_MUST_USE_APPROVED_WORKSPACE_PACKAGES");
  });
});
