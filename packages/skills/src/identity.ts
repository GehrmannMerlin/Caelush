import { createHash } from "node:crypto";
import type { SkillManifest, SkillScopeRank } from "./types.js";

export interface SkillIdentityInput {
  readonly scopeRank: SkillScopeRank;
  readonly providerId: string;
  readonly privateLocator: string;
}

export function createSkillIdentity(input: SkillIdentityInput): string {
  const identity = JSON.stringify([
    "caelush.skill.identity.v1",
    input.scopeRank,
    input.providerId,
    input.privateLocator,
  ]);
  return `skill:v1:${sha256(identity)}`;
}

export function createSkillBundleRevision(manifest: SkillManifest): string {
  const metadata = Object.entries(manifest.metadata ?? {}).sort(([left], [right]) =>
    compareCodePoints(left, right),
  );
  const normalizedManifest = [
    manifest.name,
    manifest.description,
    manifest.body,
    manifest.compatibility ?? null,
    metadata,
    manifest.userInvocable,
    manifest.modelInvocable,
  ];
  return `sha256:${sha256(JSON.stringify(["caelush.skill.bundle.v1", normalizedManifest]))}`;
}

export function compareSkillCodePoints(left: string, right: string): number {
  return compareCodePoints(left, right);
}

export function hashSkillData(value: string): string {
  return sha256(value);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
