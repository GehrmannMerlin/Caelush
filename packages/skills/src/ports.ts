import type { SkillBundleRefV1 } from "@caelush/protocol";
import type { SkillDiscoveryResult } from "./types.js";

export interface SkillProviderPort {
  discover(input: {
    readonly workspaceId: string;
    readonly signal: AbortSignal;
  }): Promise<SkillDiscoveryResult>;
}

export type SkillBundlePortReference = SkillBundleRefV1;

interface BoundedSkillResourceBase {
  readonly relativePath: string;
  readonly contentType: string;
  readonly fingerprint: string;
  readonly complete: boolean;
}

export type BoundedSkillResource =
  | (BoundedSkillResourceBase & { readonly kind: "TEXT"; readonly text: string })
  | (BoundedSkillResourceBase & { readonly kind: "BYTES"; readonly bytes: Uint8Array })
  | (BoundedSkillResourceBase & { readonly kind: "ARTIFACT"; readonly artifactRef: string });

export interface SkillBundlePort {
  capture(input: {
    readonly skillId: string;
    readonly expectedRevision?: string;
    readonly signal: AbortSignal;
  }): Promise<SkillBundlePortReference>;
  read(input: {
    readonly bundle: SkillBundlePortReference;
    readonly relativePath: string;
    readonly signal: AbortSignal;
  }): Promise<BoundedSkillResource>;
}
