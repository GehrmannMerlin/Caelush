import type { VerificationCheck } from "@caelush/protocol";
import { createVerificationCandidate } from "./candidate.js";
import type { ProjectCheckResolution } from "./contracts.js";
import type {
  ProjectCheckResolver,
  VerificationProjectPackage,
  VerificationProjectProfile,
} from "./resolver.js";

const SCRIPT_ALIASES = {
  LINT: ["lint"],
  TYPECHECK: ["typecheck", "type-check"],
  TEST: ["test"],
  BUILD: ["build"],
} as const;

const SUPPORTED_PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "" ? "." : normalized;
}

function packageJsonPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === "." ? "package.json" : `${normalized}/package.json`;
}

function packageManagerReason(
  name: string,
): "PACKAGE_MANAGER_UNKNOWN" | "PACKAGE_MANAGER_AMBIGUOUS" {
  const normalized = name.trim().toUpperCase();
  return normalized === "AMBIGUOUS" || normalized.includes("|") || normalized.includes(",")
    ? "PACKAGE_MANAGER_AMBIGUOUS"
    : "PACKAGE_MANAGER_UNKNOWN";
}

function findScript(
  packageInfo: VerificationProjectPackage | undefined,
  aliases: readonly string[],
): { packageInfo: VerificationProjectPackage; scriptName: string; command: string } | undefined {
  if (packageInfo === undefined) return undefined;
  for (const alias of aliases) {
    const script = packageInfo.scripts.find((item) => item.name === alias);
    if (script !== undefined)
      return { packageInfo, scriptName: script.name, command: script.command };
  }
  return undefined;
}

function lifecycleInputs(
  packageInfo: VerificationProjectPackage,
  scriptName: string,
): { kind: "SCRIPT"; label: string; body: string; workdir: string }[] {
  const workdir = normalizeRelativePath(packageInfo.relativePath);
  const names = [`pre${scriptName}`, scriptName, `post${scriptName}`];
  return names.flatMap((name) => {
    const script = packageInfo.scripts.find((item) => item.name === name);
    return script === undefined
      ? []
      : [{ kind: "SCRIPT" as const, label: name, body: script.command, workdir }];
  });
}

export const nodeProjectCheckResolver: ProjectCheckResolver & { readonly ecosystem: "NODE" } = {
  ecosystem: "NODE",

  resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution {
    if (check.spec.kind !== "PROJECT" || !profile.ecosystems.includes("NODE")) {
      return { kind: "UNAVAILABLE", reason: "ECOSYSTEM_UNSUPPORTED" };
    }

    const manager = profile.packageManager.name.toLowerCase();
    if (!SUPPORTED_PACKAGE_MANAGERS.has(manager)) {
      return { kind: "UNAVAILABLE", reason: packageManagerReason(profile.packageManager.name) };
    }

    const aliases = SCRIPT_ALIASES[check.spec.purpose];
    let selected:
      { packageInfo: VerificationProjectPackage; scriptName: string; command: string } | undefined;
    for (const alias of aliases) {
      selected =
        findScript(profile.rootPackage, [alias]) ?? findScript(profile.activePackage, [alias]);
      if (selected !== undefined) break;
    }
    if (selected === undefined) return { kind: "UNAVAILABLE", reason: "SCRIPT_NOT_DEFINED" };

    const workdir = normalizeRelativePath(selected.packageInfo.relativePath);
    return {
      kind: "READY",
      candidate: createVerificationCandidate({
        checkId: check.id,
        executable: manager,
        args: ["run", selected.scriptName],
        workdir,
        provenance: {
          ecosystem: "NODE",
          resolver: "NODE_PACKAGE_SCRIPT@phase-11b.v1",
          evidencePath: packageJsonPath(selected.packageInfo.relativePath),
          scriptName: selected.scriptName,
        },
        securityInputs: lifecycleInputs(selected.packageInfo, selected.scriptName),
      }),
    };
  },
};
