import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export interface SkillPackageFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export function createSkillPackageFingerprint(files: readonly SkillPackageFile[]): string {
  const digest = createHash("sha256").update("caelush.skill.bundle.v1\0", "utf8");
  const ordered = [...files].sort((left, right) =>
    compareCodePoints(left.relativePath, right.relativePath),
  );
  for (const file of ordered) {
    digest.update(file.relativePath, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(file.bytes.byteLength), "utf8");
    digest.update("\0", "utf8");
    digest.update(createHash("sha256").update(file.bytes).digest());
  }
  return `sha256:${digest.digest("hex")}`;
}

export function createSkillFileFingerprint(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function normalizeSkillRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0")
  ) {
    throw new TypeError("Skill resource path is invalid.");
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(part),
    )
  ) {
    throw new TypeError("Skill resource path is invalid.");
  }
  if (parts[0] !== "SKILL.md" && !["references", "scripts", "assets"].includes(parts[0]!)) {
    throw new TypeError("Skill resource path is outside the allowed package contents.");
  }
  if (parts[0] === "SKILL.md" && parts.length !== 1) {
    throw new TypeError("Skill manifest path is invalid.");
  }
  if (parts[0] !== "SKILL.md" && parts.length < 2) {
    throw new TypeError("Skill resource path must identify a file.");
  }
  return parts.join("/");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
