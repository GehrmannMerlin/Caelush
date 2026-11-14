import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSkillDiscovery } from "@caelush/skills";
import { afterEach, describe, expect, it, vi } from "vitest";

const daemonApi = (await import("../src/index.js")) as unknown as Record<string, unknown>;
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("filesystem Skill discovery", () => {
  it.each([65, 100, 500])(
    "keeps all %i valid skills in the discovered inventory",
    async (count) => {
      const root = await makeRoot("skills-discovery-many-");
      for (let index = 0; index < count; index += 1) {
        await writeSkill(root.user, `skill-${String(index).padStart(3, "0")}`);
      }

      const result = await discover(root);
      expect(result.complete).toBe(true);
      expect(result.candidates).toHaveLength(count);
      expect(result.diagnostics).toEqual([]);
    },
  );

  it("uses project over user over builtin while retaining distinct source identities internally", async () => {
    const root = await makeRoot("skills-discovery-priority-");
    await writeSkill(root.user, "same", "user");
    await writeSkill(root.workspace, "same", "project");
    await writeSkill(root.builtin, "same", "builtin");

    const result = await discover(root);
    const effective = resolveSkillDiscovery(result);
    expect(effective.entries).toHaveLength(1);
    expect(effective.entries[0]?.scopeRank).toBe(0);
    expect(effective.entries[0]?.manifest.description).toBe("project description");
    expect(new Set(result.candidates.map((candidate) => candidate.skillId)).size).toBe(3);
  });

  it("keeps valid candidates when one manifest or one source root fails", async () => {
    const root = await makeRoot("skills-discovery-isolation-");
    await writeSkill(root.workspace, "valid");
    const brokenDirectory = path.join(root.workspace, "broken");
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(
      path.join(brokenDirectory, "SKILL.md"),
      "---\nname: broken\nname: duplicate\ndescription: invalid\n---\nbody\n",
    );
    await rm(root.user, { recursive: true });
    await writeFile(root.user, "not-a-directory");

    const result = await discover(root);
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.manifest.name).toBe("valid");
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["YAML_DUPLICATE_KEY", "ROOT_UNREADABLE"]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(root.directory);
  });

  it("reports depth truncation as incomplete while retaining discovered candidates", async () => {
    const root = await makeRoot("skills-discovery-truncated-");
    await writeSkill(root.user, "kept");
    await writeSkill(root.user, path.join("a", "b", "c", "deep"));

    const provider = createProvider({
      userRoot: root.user,
      builtinRoots: [root.builtin],
      resolveWorkspaceRoot: async () => root.workspace,
      policy: { maxDepth: 2, maxEntriesPerRoot: 100 },
    });
    const result = await provider.discover({
      workspaceId: "workspace-test",
      signal: new AbortController().signal,
    });
    expect(result.complete).toBe(false);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.map(({ code }) => code)).toContain("SCAN_DEPTH_LIMIT");
  });

  it("reports entry truncation as incomplete while retaining discovered candidates", async () => {
    const root = await makeRoot("skills-discovery-entry-limit-");
    await writeSkill(root.user, "kept");
    await writeSkill(root.user, "another");

    const provider = createProvider({
      userRoot: root.user,
      builtinRoots: [root.builtin],
      resolveWorkspaceRoot: async () => root.workspace,
      policy: { maxEntriesPerRoot: 2 },
    });
    const result = await provider.discover({
      workspaceId: "workspace-test",
      signal: new AbortController().signal,
    });
    expect(result.complete).toBe(false);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.map(({ code }) => code)).toContain("SCAN_ENTRY_LIMIT");
  });

  it("rejects symlink escapes and does not read linked external resources", async () => {
    const root = await makeRoot("skills-discovery-symlink-");
    await writeSkill(root.user, "linked");
    await writeSkill(root.user, "safe");
    const external = path.join(root.directory, "outside");
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "secret.txt"), "external secret");
    const link = path.join(root.user, "linked", "assets", "escape");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(external, link, "junction");

    const result = await discover(root);
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.manifest.name).toBe("safe");
    expect(result.diagnostics.map(({ code }) => code)).toContain("SYMLINK_ESCAPE");
    expect(JSON.stringify(result)).not.toContain("external secret");
    expect(JSON.stringify(result.diagnostics)).not.toContain(root.directory);
  });

  it("returns a safe incomplete diagnostic for an already-cancelled discovery", async () => {
    const root = await makeRoot("skills-discovery-cancelled-");
    const controller = new AbortController();
    controller.abort();
    const result = await createProvider({
      userRoot: root.user,
      builtinRoots: [root.builtin],
      resolveWorkspaceRoot: async () => root.workspace,
    }).discover({ workspaceId: "workspace-test", signal: controller.signal });

    expect(result.complete).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain("SCAN_CANCELLED");
  });

  it("resolves a private locator for a Skill stored directly at a source root", async () => {
    const root = await makeRoot("skills-discovery-root-locator-");
    await writeFile(
      path.join(root.user, "SKILL.md"),
      "---\nname: root-skill\ndescription: root skill\n---\nbody\n",
    );
    const provider = createProvider({
      userRoot: root.user,
      builtinRoots: [root.builtin],
      resolveWorkspaceRoot: async () => path.dirname(path.dirname(root.workspace)),
    });
    const result = await provider.discover({
      workspaceId: "workspace-test",
      signal: new AbortController().signal,
    });
    expect(result.candidates).toHaveLength(1);
    const resolved = await provider.resolveLocator(
      result.candidates[0]!.privateLocator,
      "workspace-test",
    );
    expect(resolved?.packageDirectory).toBe(root.user);
  });
});

describe("Skill catalog watcher", () => {
  it("debounces/coalesces changes, supports refresh, and closes watchers on dispose", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const close = vi.fn();
    let notify: (() => void) | undefined;
    const watcherFactory = getDaemonFunction("createSkillCatalogWatcher");
    const watcher = watcherFactory({
      roots: ["C:/test/skills"],
      debounceMs: 10,
      refresh,
      watchFactory: (_root: string, onChange: () => void) => {
        notify = onChange;
        return { close };
      },
    }) as {
      start(): Promise<void>;
      refreshNow(): Promise<void>;
      dispose(): Promise<void>;
    };

    await watcher.start();
    for (let index = 0; index < 20; index += 1) notify?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledTimes(1);
    await watcher.refreshNow();
    expect(refresh).toHaveBeenCalledTimes(2);
    await watcher.dispose();
    notify?.();
    await vi.advanceTimersByTimeAsync(20);
    expect(close).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("effective Skill catalog service", () => {
  it("filters USER choices and keeps disabled/manual items only in management", async () => {
    const root = await makeRoot("skills-catalog-filter-");
    await writeSkill(root.user, "visible");
    await mkdir(path.join(root.user, "manual"), { recursive: true });
    await writeFile(
      path.join(root.user, "manual", "SKILL.md"),
      "---\nname: manual\ndescription: manual only\nuser-invocable: false\n---\nbody\n",
    );
    await writeSkill(root.user, "disabled");
    const provider = createProvider({
      userRoot: root.user,
      builtinRoots: [root.builtin],
      resolveWorkspaceRoot: async () => path.dirname(path.dirname(root.workspace)),
    });
    const disabledId = (
      await provider.discover({
        workspaceId: "workspace-test",
        signal: new AbortController().signal,
      })
    ).candidates.find((candidate) => candidate.manifest.name === "disabled")?.skillId;
    const settings = {
      getMany: async (skillIds: readonly string[]) =>
        new Map(
          skillIds.map((skillId) => [
            skillId,
            {
              skillId,
              enabled: skillId !== disabledId,
              version: skillId === disabledId ? 1 : 0,
              updatedAtMs: 0,
            },
          ]),
        ),
    };
    const serviceFactory = getDaemonFunction("createSkillCatalogService");
    const service = serviceFactory({
      provider,
      settings,
      selectionTokenSecret: new Uint8Array(32).fill(7),
    }) as {
      listUserCatalog(input: {
        workspaceId: string;
        pageSize: number;
        signal: AbortSignal;
      }): Promise<{
        items: Array<Record<string, unknown>>;
        catalogRevision: string;
      }>;
      listManagementCatalog(input: {
        workspaceId: string;
        pageSize: number;
        signal: AbortSignal;
      }): Promise<{ items: Array<Record<string, unknown>> }>;
    };

    const input = {
      workspaceId: "workspace-test",
      pageSize: 20,
      signal: new AbortController().signal,
    };
    const userPage = await service.listUserCatalog(input);
    expect(userPage.items.map((item) => item["name"])).toEqual(["visible"]);
    expect(userPage.items[0]?.["selectionToken"]).toEqual(expect.any(String));
    expect(JSON.stringify(userPage)).not.toContain(root.directory);
    const management = await service.listManagementCatalog(input);
    expect(management.items.map((item) => item["name"])).toEqual(["disabled", "manual", "visible"]);
    expect(management.items.every((item) => !("selectionToken" in item))).toBe(true);
    expect(JSON.stringify(management)).not.toContain(root.directory);
  });

  it("filters MODEL candidates by enabled and modelInvocable and projects safe metadata", async () => {
    const root = await makeRoot("skills-catalog-model-");
    await writeSkill(root.user, "model-enabled");
    await mkdir(path.join(root.user, "manual"), { recursive: true });
    await writeFile(
      path.join(root.user, "manual", "SKILL.md"),
      "---\nname: manual\ndescription: model visible only\nuser-invocable: false\n---\nbody\n",
    );
    await mkdir(path.join(root.user, "model-disabled-by-manifest"), { recursive: true });
    await writeFile(
      path.join(root.user, "model-disabled-by-manifest", "SKILL.md"),
      "---\nname: model-disabled-by-manifest\ndescription: hidden from model\ndisable-model-invocation: true\n---\nbody\n",
    );
    await writeSkill(root.user, "disabled");
    const provider = createProvider({
      userRoot: root.user,
      builtinRoots: [root.builtin],
      resolveWorkspaceRoot: async () => path.dirname(path.dirname(root.workspace)),
    });
    const disabledId = (
      await provider.discover({
        workspaceId: "workspace-test",
        signal: new AbortController().signal,
      })
    ).candidates.find((candidate) => candidate.manifest.name === "disabled")?.skillId;
    const serviceFactory = getDaemonFunction("createSkillCatalogService");
    const service = serviceFactory({
      provider,
      settings: {
        getMany: async (skillIds: readonly string[]) =>
          new Map(
            skillIds.map((skillId) => [
              skillId,
              {
                skillId,
                enabled: skillId !== disabledId,
                version: skillId === disabledId ? 1 : 0,
                updatedAtMs: 0,
              },
            ]),
          ),
      },
    }) as {
      listModelCatalog(input: {
        workspaceId: string;
        pageSize: number;
        signal: AbortSignal;
      }): Promise<{ items: Array<Record<string, unknown>> }>;
    };

    const modelPage = await service.listModelCatalog({
      workspaceId: "workspace-test",
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(modelPage.items.map((item) => item["name"])).toEqual(["manual", "model-enabled"]);
    expect(
      modelPage.items.every(
        (item) => Object.keys(item).sort().join(",") === "description,name,skillId",
      ),
    ).toBe(true);
  });

  it("rejects cursors when the query or effective catalog revision changes", async () => {
    const root = await makeRoot("skills-catalog-cursor-");
    await writeSkill(root.user, "alpha");
    await writeSkill(root.user, "beta");
    const serviceFactory = getDaemonFunction("createSkillCatalogService");
    const service = serviceFactory({
      provider: createProvider({
        userRoot: root.user,
        builtinRoots: [root.builtin],
        resolveWorkspaceRoot: async () => path.dirname(path.dirname(root.workspace)),
      }),
      settings: { getMany: async () => new Map() },
      selectionTokenSecret: new Uint8Array(32).fill(9),
    }) as {
      listUserCatalog(input: {
        workspaceId: string;
        query?: string;
        pageSize: number;
        cursor?: string;
        signal: AbortSignal;
      }): Promise<{ nextCursor?: string }>;
      invalidate(workspaceId?: string): void;
    };
    const signal = new AbortController().signal;
    const firstPage = await service.listUserCatalog({
      workspaceId: "workspace-test",
      pageSize: 1,
      signal,
    });
    const cursor = firstPage.nextCursor;
    expect(cursor).toBeDefined();
    await expect(
      service.listUserCatalog({
        workspaceId: "workspace-test",
        query: "alpha",
        pageSize: 1,
        cursor,
        signal,
      }),
    ).rejects.toMatchObject({ name: "InvalidSkillCatalogCursorError" });

    await writeSkill(root.user, "alpha", "changed");
    service.invalidate("workspace-test");
    await expect(
      service.listUserCatalog({ workspaceId: "workspace-test", pageSize: 1, cursor, signal }),
    ).rejects.toMatchObject({ name: "StaleSkillCatalogCursorError" });
  });
});

interface RootFixture {
  readonly directory: string;
  readonly user: string;
  readonly workspace: string;
  readonly builtin: string;
}

async function makeRoot(prefix: string): Promise<RootFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  const root = {
    directory,
    user: path.join(directory, "user"),
    workspace: path.join(directory, "workspace", ".agents", "skills"),
    builtin: path.join(directory, "builtin"),
  };
  await Promise.all([
    mkdir(root.user, { recursive: true }),
    mkdir(root.workspace, { recursive: true }),
    mkdir(root.builtin, { recursive: true }),
  ]);
  return root;
}

async function writeSkill(root: string, relativePath: string, source = "valid") {
  const directory = path.join(root, relativePath);
  await mkdir(directory, { recursive: true });
  const name = path.basename(relativePath).replace(/[^a-z0-9-]/gu, "-");
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${source} description\n---\n${source} body\n`,
  );
}

async function discover(root: RootFixture) {
  return createProvider({
    userRoot: root.user,
    builtinRoots: [root.builtin],
    resolveWorkspaceRoot: async () => path.dirname(path.dirname(root.workspace)),
  }).discover({ workspaceId: "workspace-test", signal: new AbortController().signal });
}

function createProvider(input: Record<string, unknown>) {
  const factory = getDaemonFunction("createFilesystemSkillProvider");
  return factory(input) as {
    discover(input: { workspaceId: string; signal: AbortSignal }): Promise<{
      candidates: Array<{
        skillId: string;
        scopeRank: number;
        privateLocator: string;
        manifest: { name: string; description: string };
      }>;
      diagnostics: Array<{ code: string; safeMessage: string }>;
      complete: boolean;
    }>;
    resolveLocator(
      locator: string,
      workspaceId?: string,
    ): Promise<{ packageDirectory: string } | null>;
  };
}

function getDaemonFunction(name: string): (...args: readonly unknown[]) => unknown {
  const value = daemonApi[name];
  expect(value, `${name} is available from the daemon catalog surface`).toBeTypeOf("function");
  return value as (...args: readonly unknown[]) => unknown;
}
