import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const workspacePath = process.cwd();
const productionOutput = new URL("../dist/", import.meta.url);
const processApis = [
  "env",
  "versions",
  "platform",
  "cwd",
  "stdin",
  "stdout",
  "stderr",
  "exit",
  "argv",
] as const;
const processApiAccess = String.raw`(?:\.\s*(?:${processApis.join("|")})\b|\?\.\s*(?:${processApis.join("|")})\b|\[\s*["'](?:${processApis.join("|")})["']\s*\]|\?\.\s*\[\s*["'](?:${processApis.join("|")})["']\s*\])`;
const nodeOnlyMarkerPatterns = [
  /(?:^|[^\w$.])(?:new\s+)?Buffer\s*(?:\(|\?|\.|\[)/,
  /(?:^|[^\w$.])globalThis(?:\?\.)?\.Buffer\b/,
  new RegExp(String.raw`(?:^|[^\w$.])process${processApiAccess}`),
  new RegExp(String.raw`(?:^|[^\w$.])globalThis(?:\.|\?\.)process${processApiAccess}`),
  /(?:from|import)\s*\(?["']node:/,
  /\brequire\s*\(\s*["']node:/,
];

describe("Web production build", () => {
  it("detects executable Node-only forms without treating process event names as APIs", () => {
    const executableForms = [
      "new Buffer(8)",
      "Buffer(input)",
      "globalThis.Buffer.from(input)",
      ...processApis.map((api) => `process.${api}`),
      ...processApis.map((api) => `process?.${api}`),
      ...processApis.map((api) => `process["${api}"]`),
      ...processApis.map((api) => `globalThis.process.${api}`),
      ...processApis.map((api) => `globalThis.process?.["${api}"]`),
      ...processApis.map((api) => `globalThis?.process.${api}`),
      ...processApis.map((api) => `globalThis?.process?.["${api}"]`),
      'import "node:fs"',
      'import("node:fs")',
      'from "node:fs"',
      'require("node:fs")',
    ];

    for (const source of executableForms) {
      expect(hasNodeOnlyMarker(source), source).toBe(true);
    }
    expect(hasNodeOnlyMarker("process.started")).toBe(false);
    expect(
      hasNodeOnlyMarker(
        'typeof process !== "undefined" && typeof process?.versions?.node === "string"',
      ),
    ).toBe(false);
    expect(hasNodeOnlyMarker('typeof process !== "undefined" && process.env.NODE_ENV')).toBe(false);
  });

  it("contains no Node-only dependency markers", async () => {
    // `vite` is a devDependency of this app, so its shim lives in the app's own
    // `node_modules/.bin`. Resolving it from the workspace root only worked in a
    // long-lived checkout where a stale root shim happened to survive; a fresh
    // `pnpm install --frozen-lockfile` puts it here and nowhere else.
    await execFile(
      process.platform === "win32" ? "cmd.exe" : "pnpm",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "node_modules\\.bin\\vite.cmd build"]
        : ["--filter", "@caelush/web", "build"],
      { cwd: process.platform === "win32" ? new URL("../", import.meta.url) : workspacePath },
    );

    const assets = await filesIn(productionOutput);
    const output = await Promise.all(assets.map((asset) => readFile(asset, "utf8")));
    expect(hasNodeOnlyMarker(output.join("\n"))).toBe(false);
  }, 20_000);
});

function hasNodeOnlyMarker(source: string): boolean {
  const processMarkers = nodeOnlyMarkerPatterns.slice(2, 4);
  const nonProcessMarkers = [
    ...nodeOnlyMarkerPatterns.slice(0, 2),
    ...nodeOnlyMarkerPatterns.slice(4),
  ];
  if (nonProcessMarkers.some((marker) => marker.test(source))) return true;

  return processMarkers.some((marker) => {
    const global = new RegExp(marker.source, "gu");
    for (const match of source.matchAll(global)) {
      const start = match.index ?? 0;
      const previousStatement = Math.max(
        source.lastIndexOf(";", start),
        source.lastIndexOf("{", start),
      );
      const prefix = source.slice(previousStatement + 1, start);
      if (/(?:typeof\s+(?:globalThis(?:\?\.|\.)?)?process[^;{}]*&&|typeof\s*)$/u.test(prefix)) {
        continue;
      }
      return true;
    }
    return false;
  });
}

async function filesIn(directory: URL): Promise<readonly URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = new URL(entry.name, directory);
      return entry.isDirectory() ? filesIn(new URL(`${entry.name}/`, directory)) : [path];
    }),
  );
  return nested.flat();
}
