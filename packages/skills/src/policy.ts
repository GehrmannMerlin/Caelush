import type { SkillManifest } from "./types.js";

export type SkillInvocationAudience = "USER" | "MODEL";

export function isSkillInvocable(
  manifest: SkillManifest,
  audience: SkillInvocationAudience,
): boolean {
  switch (audience) {
    case "USER":
      return manifest.userInvocable;
    case "MODEL":
      return manifest.modelInvocable;
    default:
      return false;
  }
}
