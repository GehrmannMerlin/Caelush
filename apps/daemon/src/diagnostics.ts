import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { getCaelushMigrationsFolder } from "@caelush/storage";

export interface NodePtyLoadability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface MigrationAssetInspection {
  readonly available: boolean;
  readonly migrationCount: number;
}

export async function checkNodePtyLoadability(): Promise<NodePtyLoadability> {
  try {
    const runtimeEntry = await import.meta.resolve("@caelush/runtime");
    createRequire(runtimeEntry)("node-pty");
    return { available: true };
  } catch {
    return { available: false, reason: "node-pty is not loadable" };
  }
}

export function inspectMigrationAssets(): MigrationAssetInspection {
  const folder = getCaelushMigrationsFolder();
  if (!existsSync(folder)) return { available: false, migrationCount: 0 };
  const migrationCount = readdirSync(folder, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  ).length;
  return { available: migrationCount > 0, migrationCount };
}
