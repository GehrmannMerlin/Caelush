import path from "node:path";
import type { WorkspaceScope } from "./workspace.js";

export interface EnvironmentSnapshot {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hostNodeVersion: string;
  readonly pathStyle: "POSIX" | "WINDOWS";
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  readonly cwd: string;
}

export interface EnvironmentDetector {
  detect(scope: WorkspaceScope, projectRoot: string): EnvironmentSnapshot;
}

export class LocalEnvironmentDetector implements EnvironmentDetector {
  detect(scope: WorkspaceScope, projectRoot: string): EnvironmentSnapshot {
    return {
      platform: process.platform,
      arch: process.arch,
      hostNodeVersion: process.version,
      pathStyle: path.sep === "\\" ? "WINDOWS" : "POSIX",
      workspaceRoot: scope.realRoot,
      projectRoot,
      cwd: scope.realCwd,
    };
  }
}
