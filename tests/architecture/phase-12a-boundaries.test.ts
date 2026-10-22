import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyEntries, readManifest, repositoryRoot } from "./support/workspace.js";

async function sourceTree(relativeRoot: string): Promise<string> {
  const root = path.join(repositoryRoot, relativeRoot);
  const entries = await readdir(root, { recursive: true });
  const files = entries
    .filter((entry): entry is string => entry.endsWith(".ts"))
    .map((entry) => path.join(root, entry));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

describe("Phase 12A daemon and shared-client boundaries", () => {
  it("keeps the shared client transport on Protocol and browser APIs only", async () => {
    const client = await readManifest("packages/client/package.json");
    expect(Object.keys(dependencyEntries(client))).toEqual(["@caelush/protocol"]);
    const source = await sourceTree("packages/client/src");
    expect(source).not.toMatch(
      /from\s+["']@caelush\/(?:core|runtime|storage|security|agent|coding-agent|context|verification|llm|events|daemon|cli|web)["']/,
    );
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/\b(?:EventSource|WebSocket|Fastify|AgentLoop|RunController)\b/);
  });

  it("keeps CLI and Web as clients without Kernel or host-runtime dependencies", async () => {
    for (const appName of ["cli", "web"] as const) {
      const manifest = await readManifest(`apps/${appName}/package.json`);
      // Phase 4F deleted `@caelush/tools`; the Tool System's live packages are the general kernel
      // `@caelush/agent` and the Coding product layer `@caelush/coding-agent`, and a host app
      // depends on neither.
      expect(Object.keys(dependencyEntries(manifest))).not.toEqual(
        expect.arrayContaining([
          "@caelush/core",
          "@caelush/runtime",
          "@caelush/storage",
          "@caelush/security",
          "@caelush/agent",
          "@caelush/coding-agent",
        ]),
      );
      const source = await sourceTree(`apps/${appName}/src`);
      expect(source).not.toMatch(
        /from\s+["']@caelush\/(?:core|runtime|storage|security|agent|coding-agent|context|verification|llm)["']/,
      );
    }
  });

  it("keeps route registration thin and composition in the daemon root", async () => {
    const routes = await sourceTree("apps/daemon/src/routes");
    expect(routes).not.toMatch(
      /new\s+(?:RunController|LocalRuntime|ToolDispatcher|LLMGateway)\s*\(/,
    );
    expect(routes).not.toMatch(/from\s+["']@caelush\/(?:core|runtime|agent|coding-agent|llm)["']/);
  });

  it("keeps the Security policy Gate on the live Tool owners", async () => {
    // Phase 4F deleted `@caelush/tools`. The Security policy Gate consumes the general gate contract
    // types from `@caelush/agent`, the Coding Tool metadata types from `@caelush/coding-agent`, the
    // durable Protocol contracts, and the Runtime the facts are evaluated against — and nothing else.
    const security = await readManifest("packages/security/package.json");
    expect(Object.keys(dependencyEntries(security)).sort()).toEqual([
      "@caelush/agent",
      "@caelush/coding-agent",
      "@caelush/protocol",
      "@caelush/runtime",
    ]);

    // The deleted legacy Tool package is imported nowhere: the contract types it once owned are the
    // Agent layer's now, and the Coding metadata is the Coding layer's.
    const source = await sourceTree("packages/security/src");
    expect(source).toMatch(/from\s+["']@caelush\/agent["']/);
    expect(source).toMatch(/from\s+["']@caelush\/coding-agent["']/);
    expect(source).not.toMatch(/from\s+["']@caelush\/tools["']/);
  });

  it("keeps provider and Run-process execution out of daemon production adapters", async () => {
    const daemon = await sourceTree("apps/daemon/src");
    /*
     * Three host-level files are allowed to reach the machine, and each is checked for the bound
     * that makes it a host concern rather than Run execution:
     *
     * ```text
     * workspace-picker.ts   the Windows folder dialog; one bounded, cancellable child
     * desktop-entry.ts      the daemon's own /info handshake, with its host token
     * replay/windows-dpapi.ts  DPAPI unprotect for the private replay key, ≤ 8 KiB
     * ```
     *
     * The allowlist is explicit and per file. It is not "the daemon may spawn": every other file in
     * `apps/daemon/src` is still forbidden from reaching the host, so a new provider transport or a
     * Run command smuggled into a route fails this guard.
     */
    const pickerPath = path.join(
      repositoryRoot,
      "apps",
      "daemon",
      "src",
      "workspaces",
      "workspace-picker.ts",
    );
    const desktopEntryPath = path.join(repositoryRoot, "apps", "daemon", "src", "desktop-entry.ts");
    const dpapiPath = path.join(
      repositoryRoot,
      "apps",
      "daemon",
      "src",
      "replay",
      "windows-dpapi.ts",
    );
    const picker = await readFile(pickerPath, "utf8");
    const desktopEntry = await readFile(desktopEntryPath, "utf8");
    const dpapi = await readFile(dpapiPath, "utf8");
    expect(picker).toContain('import { execFile } from "node:child_process"');
    expect(picker).toContain("System.Windows.Forms.FolderBrowserDialog");
    expect(picker).toContain("WORKSPACE_PICKER_TIMEOUT_MS");
    expect(picker).toContain("child.kill()");
    expect(desktopEntry).toContain("/api/v1/info");
    expect(desktopEntry).toContain("x-caelush-host-token");
    expect(dpapi).toContain("bytes.byteLength > 8192");
    expect(dpapi).toContain('process.platform !== "win32"');

    const daemonWithoutHostFiles = daemon
      .replace(picker, "")
      .replace(desktopEntry, "")
      .replace(dpapi, "");
    expect(daemonWithoutHostFiles).not.toMatch(/\b(?:fetch|spawn|execFile|nodePty)\s*\(/);
    expect(daemonWithoutHostFiles).not.toMatch(/from\s+["']node:child_process["']/);
    expect(daemonWithoutHostFiles).not.toMatch(
      /\b(?:React|Ink|EventSource|WebSocket|cors|MCP|Browser|Computer)\b/i,
    );
  });
});
