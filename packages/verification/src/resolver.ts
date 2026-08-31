import type { VerificationCheck } from "@caelush/protocol";
import type { ProjectCheckResolution, VerificationDiscoveryReason } from "./contracts.js";
import { nodeProjectCheckResolver } from "./node-resolver.js";

export interface VerificationProjectPackage {
  readonly relativePath: string;
  readonly scripts: readonly { readonly name: string; readonly command: string }[];
}

export interface VerificationProjectProfile {
  readonly ecosystems: readonly string[];
  readonly packageManager: { readonly name: string; readonly source?: string };
  readonly tooling: readonly { readonly name: string; readonly evidencePaths: readonly string[] }[];
  readonly isMonorepo: boolean;
  readonly rootPackage?: VerificationProjectPackage;
  readonly activePackage?: VerificationProjectPackage;
}

export interface ProjectCheckResolver {
  readonly ecosystem?: string;
  resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution;
}

export class ProjectCheckResolverRegistry {
  private readonly resolvers: readonly ProjectCheckResolver[];

  constructor(resolvers: readonly ProjectCheckResolver[] = [nodeProjectCheckResolver]) {
    this.resolvers = [...resolvers];
  }

  resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution {
    if (check.spec.kind !== "PROJECT")
      return { kind: "UNAVAILABLE", reason: "UNSUPPORTED_ECOSYSTEM" };

    const resolver = this.resolvers.find(
      (candidate) =>
        candidate.ecosystem === undefined || profile.ecosystems.includes(candidate.ecosystem),
    );
    if (resolver === undefined) return { kind: "UNAVAILABLE", reason: "UNSUPPORTED_ECOSYSTEM" };
    return resolver.resolve(check, profile);
  }
}

export type { ProjectCheckResolution, VerificationDiscoveryReason } from "./contracts.js";
