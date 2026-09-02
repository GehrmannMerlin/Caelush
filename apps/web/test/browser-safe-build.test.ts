import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const workspacePath = process.cwd();
const productionOutput = new URL("../dist/", import.meta.url);
const nodeOnlyMarkers = [
  /(?:^|[^\w$.])Buffer(?:\.|\[)/,
  /(?:^|[^\w$.])process\.(?:env|versions|platform|cwd|stdin|stdout|stderr|exit|argv)\b/,
  /(?:from|import)\s*\(?["']node:/,
];

describe("Web production build", () => {
  it("contains no Node-only dependency markers", async () => {
    await execFile(
      process.platform === "win32" ? "cmd.exe" : "pnpm",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm --filter @caelush/web build"]
        : ["--filter", "@caelush/web", "build"],
      { cwd: workspacePath },
    );

    const assets = await filesIn(productionOutput);
    const output = await Promise.all(assets.map((asset) => readFile(asset, "utf8")));
    for (const marker of nodeOnlyMarkers) expect(output.join("\n")).not.toMatch(marker);
  }, 20_000);
});

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
