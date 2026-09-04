import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createAgentLoopAuditFixture(): Promise<{
  readonly parent: string;
  readonly workspace: string;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-agent-loop-fixture-"));
  const workspace = path.join(parent, "workspace");
  await mkdir(path.join(workspace, "apps", "web", "src"), { recursive: true });
  await mkdir(path.join(workspace, "apps", "api", "src"), { recursive: true });
  await mkdir(path.join(workspace, "packages", "shared", "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), '{"private":true}\n', "utf8");
  await writeFile(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
  await writeFile(path.join(workspace, "README.md"), "Read-only audit fixture.\n", "utf8");
  await writeFile(path.join(workspace, "apps", "web", "src", "main.ts"), "export {};\n", "utf8");
  await writeFile(path.join(workspace, "apps", "api", "src", "server.ts"), "export {};\n", "utf8");
  await writeFile(
    path.join(workspace, "packages", "shared", "src", "index.ts"),
    "export const shared = true;\n",
    "utf8",
  );
  return { parent, workspace };
}

export async function removeAgentLoopAuditFixture(parent: string): Promise<void> {
  await rm(parent, { recursive: true, force: true });
}
