import type { ProjectInspector, ProjectProfile } from "@caelush/context";
import type { AgentRun } from "@caelush/protocol";
import type { ProjectProfileProviderPort, RunExecutionConfig } from "./run-controller-ports.js";
import type { VerificationProjectProfile } from "@caelush/verification";

export function createProjectProfileProvider(
  inspector: Pick<ProjectInspector, "inspect">,
): ProjectProfileProviderPort {
  return {
    async getFreshProfile(
      run: AgentRun,
      config: RunExecutionConfig,
    ): Promise<VerificationProjectProfile> {
      const snapshot = await inspector.inspect({
        workspace: run.workspace,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      });
      return toVerificationProjectProfile(snapshot.profile);
    },
  };
}

export function toVerificationProjectProfile(profile: ProjectProfile): VerificationProjectProfile {
  return {
    ecosystems: [...profile.ecosystems],
    packageManager: {
      name:
        profile.packageManager.source === "AMBIGUOUS" ? "AMBIGUOUS" : profile.packageManager.name,
      ...(profile.packageManager.source === undefined
        ? {}
        : { source: profile.packageManager.source }),
    },
    tooling: profile.tooling.map((tool) => ({
      name: tool.name,
      evidencePaths: [...tool.evidencePaths],
    })),
    isMonorepo: profile.isMonorepo,
    ...(profile.rootPackage === undefined
      ? {}
      : { rootPackage: toVerificationPackage(profile.rootPackage) }),
    ...(profile.activePackage === undefined
      ? {}
      : { activePackage: toVerificationPackage(profile.activePackage) }),
  };
}

function toVerificationPackage(packageInfo: ProjectProfile["rootPackage"]): {
  readonly relativePath: string;
  readonly scripts: readonly { readonly name: string; readonly command: string }[];
} {
  if (packageInfo === undefined) throw new Error("Project package is missing");
  return {
    relativePath: packageInfo.relativePath === "" ? "." : packageInfo.relativePath,
    scripts: packageInfo.scripts.map((script) => ({ name: script.name, command: script.command })),
  };
}
