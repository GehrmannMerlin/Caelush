import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopDaemonResources } from "./supervisor.js";

export interface DesktopResourceLayout {
  readonly packaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
}

/** Resolves only the controlled D4 development stage or the future D6 resource layout. */
export async function resolveDesktopDaemonResources(
  layout: DesktopResourceLayout,
): Promise<DesktopDaemonResources> {
  const paths = layout.packaged
    ? {
        nodeExecutablePath: path.join(layout.resourcesPath, "daemon", "node.exe"),
        daemonEntryPath: path.join(layout.resourcesPath, "daemon", "desktop-entry.js"),
      }
    : {
        nodeExecutablePath: path.resolve(layout.appPath, ".stage", "daemon", "node.exe"),
        daemonEntryPath: path.resolve(
          layout.appPath,
          "..",
          "daemon",
          "dist",
          "desktop-entry.js",
        ),
      };
  for (const filePath of Object.values(paths)) {
    await access(filePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("Desktop Daemon resource is unavailable.");
    const canonical = await realpath(filePath);
    if (path.resolve(canonical) !== path.resolve(filePath)) {
      throw new Error("Desktop Daemon resource path is unsafe.");
    }
  }
  return Object.freeze(paths);
}

export function resolveDesktopWebRoot(layout: DesktopResourceLayout): string {
  return layout.packaged
    ? path.join(layout.resourcesPath, "web", "desktop")
    : path.resolve(layout.appPath, "..", "web", "dist", "desktop");
}
