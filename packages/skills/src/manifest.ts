import { parseDocument } from "yaml";
import type { SkillDiagnostic, SkillManifest, SkillManifestParseResult } from "./types.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_NAME_CHARACTERS = 64;
const MAX_DESCRIPTION_CHARACTERS = 1024;
const MAX_DESCRIPTION_BYTES = 4096;
const MAX_YAML_ALIAS_COUNT = 100;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const utf8Encoder = new TextEncoder();

const SAFE_MESSAGES = {
  MANIFEST_TOO_LARGE: "Skill manifest exceeds the 256 KiB size limit.",
  FRONTMATTER_INVALID: "Skill manifest front matter is missing or invalid.",
  YAML_INVALID: "Skill manifest YAML is invalid.",
  YAML_DUPLICATE_KEY: "Skill manifest YAML contains a duplicate key.",
  YAML_ALIAS_LIMIT_EXCEEDED: "Skill manifest YAML exceeds the alias expansion limit.",
  NAME_REQUIRED: "Skill manifest requires a name.",
  NAME_INVALID: "Skill manifest name must use lowercase letters, digits, and hyphens.",
  NAME_TOO_LONG: "Skill manifest name exceeds 64 characters.",
  DESCRIPTION_REQUIRED: "Skill manifest requires a description.",
  DESCRIPTION_TOO_LONG: "Skill manifest description exceeds 1024 characters.",
  DESCRIPTION_TOO_LARGE: "Skill manifest description exceeds 4096 UTF-8 bytes.",
  COMPATIBILITY_INVALID: "Skill manifest compatibility must be text.",
  METADATA_INVALID: "Skill manifest metadata must contain only text values.",
  INVOCATION_POLICY_INVALID: "Skill manifest invocation policies must be booleans.",
} as const;

type ManifestDiagnosticCode = keyof typeof SAFE_MESSAGES;

interface FrontmatterParts {
  readonly yaml: string;
  readonly body: string;
}

export function parseSkillManifest(text: string): SkillManifestParseResult {
  if (utf8Encoder.encode(text).byteLength > MAX_MANIFEST_BYTES) {
    return failure("MANIFEST_TOO_LARGE");
  }

  const normalized = normalizeLineEndings(stripLeadingBom(text));
  const parts = splitFrontmatter(normalized);
  if (parts === undefined) return failure("FRONTMATTER_INVALID");

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(parts.yaml, {
      uniqueKeys: true,
      stringKeys: true,
      version: "1.2",
      schema: "core",
      prettyErrors: false,
    });
  } catch {
    return failure("YAML_INVALID");
  }

  if (document.errors.some((error) => error.code === "DUPLICATE_KEY")) {
    return failure("YAML_DUPLICATE_KEY");
  }
  if (document.errors.length > 0) return failure("YAML_INVALID");

  let parsed: unknown;
  try {
    parsed = document.toJS({ mapAsMap: true, maxAliasCount: MAX_YAML_ALIAS_COUNT });
  } catch (error) {
    if (error instanceof ReferenceError) return failure("YAML_ALIAS_LIMIT_EXCEEDED");
    return failure("YAML_INVALID");
  }

  if (!(parsed instanceof Map) || !hasOnlyStringKeys(parsed)) {
    return failure("FRONTMATTER_INVALID");
  }

  const diagnostics: SkillDiagnostic[] = [];
  const name = parsed.get("name");
  if (typeof name !== "string" || name.length === 0) {
    diagnostics.push(diagnostic("NAME_REQUIRED"));
  } else if (codePointLength(name) > MAX_NAME_CHARACTERS) {
    diagnostics.push(diagnostic("NAME_TOO_LONG"));
  } else if (!isStandardName(name)) {
    diagnostics.push(diagnostic("NAME_INVALID"));
  }

  const description = parsed.get("description");
  if (typeof description !== "string" || description.trim().length === 0) {
    diagnostics.push(diagnostic("DESCRIPTION_REQUIRED"));
  } else {
    if (codePointLength(description) > MAX_DESCRIPTION_CHARACTERS) {
      diagnostics.push(diagnostic("DESCRIPTION_TOO_LONG"));
    }
    if (utf8Encoder.encode(description).byteLength > MAX_DESCRIPTION_BYTES) {
      diagnostics.push(diagnostic("DESCRIPTION_TOO_LARGE"));
    }
  }

  const compatibility = parsed.get("compatibility");
  if (compatibility !== undefined && typeof compatibility !== "string") {
    diagnostics.push(diagnostic("COMPATIBILITY_INVALID"));
  }

  const metadataValue = parsed.get("metadata");
  const metadata = readMetadata(metadataValue);
  if (metadata === INVALID_METADATA) diagnostics.push(diagnostic("METADATA_INVALID"));

  const disableModelInvocation = parsed.get("disable-model-invocation");
  const userInvocableValue = parsed.get("user-invocable");
  if (
    (disableModelInvocation !== undefined && typeof disableModelInvocation !== "boolean") ||
    (userInvocableValue !== undefined && typeof userInvocableValue !== "boolean")
  ) {
    diagnostics.push(diagnostic("INVOCATION_POLICY_INVALID"));
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const manifest: SkillManifest = {
    name: name as string,
    description: description as string,
    body: parts.body,
    ...(typeof compatibility === "string" ? { compatibility } : {}),
    ...(metadata === undefined || metadata === INVALID_METADATA ? {} : { metadata }),
    userInvocable: userInvocableValue !== false,
    modelInvocable: disableModelInvocation !== true,
  };

  return { ok: true, manifest };
}

const INVALID_METADATA = Symbol("invalid-metadata");

function readMetadata(
  value: unknown,
): Readonly<Record<string, string>> | undefined | typeof INVALID_METADATA {
  if (value === undefined) return undefined;
  if (!(value instanceof Map) || !hasOnlyStringKeys(value)) return INVALID_METADATA;

  const entries: Array<readonly [string, string]> = [];
  for (const [key, entry] of value) {
    if (typeof entry !== "string") return INVALID_METADATA;
    entries.push([key, entry]);
  }
  entries.sort(([left], [right]) => compareCodePoints(left, right));
  return Object.freeze(Object.fromEntries(entries));
}

function hasOnlyStringKeys(
  value: ReadonlyMap<unknown, unknown>,
): value is ReadonlyMap<string, unknown> {
  for (const key of value.keys()) {
    if (typeof key !== "string") return false;
  }
  return true;
}

function splitFrontmatter(text: string): FrontmatterParts | undefined {
  if (!text.startsWith("---\n")) return undefined;

  let searchFrom = 3;
  while (searchFrom < text.length) {
    const delimiterStart = text.indexOf("\n---", searchFrom);
    if (delimiterStart < 0) return undefined;

    const afterDelimiter = delimiterStart + 4;
    const atLineEnd = afterDelimiter === text.length || text[afterDelimiter] === "\n";
    if (atLineEnd) {
      const bodyStart = afterDelimiter === text.length ? afterDelimiter : afterDelimiter + 1;
      return {
        yaml: text.slice(4, delimiterStart),
        body: text.slice(bodyStart),
      };
    }

    searchFrom = afterDelimiter;
  }
  return undefined;
}

function stripLeadingBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isStandardName(value: string): boolean {
  const match = NAME_PATTERN.exec(value);
  return match?.[0] === value;
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

function diagnostic(code: ManifestDiagnosticCode): SkillDiagnostic {
  return { code, severity: "ERROR", safeMessage: SAFE_MESSAGES[code] };
}

function failure(code: ManifestDiagnosticCode): SkillManifestParseResult {
  return { ok: false, diagnostics: [diagnostic(code)] };
}
