import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { LocalContextFileSystem } from "../src/filesystem.js";
import { ProjectProfileDetector } from "../src/project-profile.js";
import { WorkspaceScopeResolver } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function profileFixture(): Promise<{
  root: string;
  cwd: string;
  scope: Awaited<ReturnType<WorkspaceScopeResolver["resolve"]>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-context-profile-"));
  const cwd = path.join(root, "packages", "app", "src");
  await mkdir(cwd, { recursive: true });
  temporaryDirectories.push(root);
  const scope = await new WorkspaceScopeResolver(new LocalContextFileSystem()).resolve(
    { id: createWorkspaceId(), path: root },
    cwd,
  );
  return { root, cwd, scope };
}

describe("ProjectProfileDetector", () => {
  it("collects ecosystem, package, monorepo, and manager evidence without dependencies", async () => {
    const { root, cwd, scope } = await profileFixture();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "repo",
        packageManager: "pnpm@11.21.0",
        engines: { node: ">=24" },
        scripts: { test: "vitest", build: "tsc", lint: "eslint" },
        workspaces: ["packages/*"],
        dependencies: { shouldNotAppear: "1.0.0" },
      }),
      "utf8",
    );
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
    await writeFile(path.join(root, "tsconfig.json"), "{}", "utf8");
    await writeFile(
      path.join(root, "packages", "app", "package.json"),
      '{"name":"active-app"}',
      "utf8",
    );

    const result = await new ProjectProfileDetector(new LocalContextFileSystem()).detect(
      scope,
      root,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.profile.ecosystems).toEqual(["NODE"]);
    expect(result.profile.languageSignals).toEqual(["TYPESCRIPT"]);
    expect(result.profile.packageManager).toMatchObject({
      name: "pnpm",
      versionHint: "11.21.0",
      source: "PACKAGE_MANAGER_FIELD",
    });
    expect(result.profile.isMonorepo).toBe(true);
    expect(result.profile.rootPackage?.name).toBe("repo");
    expect(result.profile.activePackage?.name).toBe("active-app");
    expect(result.profile.rootPackage?.scripts.map((script) => script.name)).toEqual([
      "build",
      "lint",
      "test",
    ]);
    expect(JSON.stringify(result.profile)).not.toContain("shouldNotAppear");
    expect(result.profile.manifestEvidence.map((entry) => entry.relativePath)).toContain(
      path.relative(root, path.join(root, "packages", "app", "package.json")),
    );
    expect(cwd).toContain("src");
  });

  it("detects Python, Rust, Go, Java, and lockfile manager signals", async () => {
    const { root, scope } = await profileFixture();
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname='demo'\n", "utf8");
    await writeFile(path.join(root, "uv.lock"), "version = 1\n", "utf8");
    await writeFile(path.join(root, "Cargo.toml"), "[package]\nname='demo'\n", "utf8");
    await writeFile(path.join(root, "go.mod"), "module example.com/demo\n", "utf8");
    await writeFile(path.join(root, "pom.xml"), "<project />", "utf8");

    const result = await new ProjectProfileDetector(new LocalContextFileSystem()).detect(
      scope,
      root,
    );

    expect(result.profile.ecosystems).toEqual(["PYTHON", "RUST", "GO", "JAVA"]);
    expect(result.profile.packageManager).toMatchObject({ name: "uv", source: "LOCKFILE" });
    expect(result.profile.manifestEvidence.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(["pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"]),
    );
  });

  it("does not guess when lockfile manager evidence conflicts", async () => {
    const { root, scope } = await profileFixture();
    await writeFile(path.join(root, "package.json"), '{"name":"repo"}', "utf8");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");

    const result = await new ProjectProfileDetector(new LocalContextFileSystem()).detect(
      scope,
      root,
    );

    expect(result.profile.packageManager).toMatchObject({ name: "UNKNOWN", source: "AMBIGUOUS" });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "AMBIGUOUS_PACKAGE_MANAGER" })]),
    );
  });

  it("turns malformed package JSON into a diagnostic and continues", async () => {
    const { root, scope } = await profileFixture();
    await writeFile(path.join(root, "package.json"), '{"name":', "utf8");
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname='demo'\n", "utf8");

    const result = await new ProjectProfileDetector(new LocalContextFileSystem()).detect(
      scope,
      root,
    );

    expect(result.profile.ecosystems).toEqual(["NODE", "PYTHON"]);
    expect(result.profile.rootPackage).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "MALFORMED_MANIFEST", severity: "WARNING" }),
    ]);
  });
});
