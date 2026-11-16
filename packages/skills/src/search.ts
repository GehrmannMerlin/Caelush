import { createHash } from "node:crypto";
import { projectSkillCatalogSearchEntries } from "./catalog.js";
import {
  normalizeSkillSearchText,
  querySkillSearchTerms,
  skillSearchCorpusTerms,
} from "./search-terms.js";
import type { SkillInvocationAudience } from "./policy.js";
import type { SkillCatalogSearchSource } from "./types.js";

const MAX_CURSOR_BYTES = 2048;
const cursorKeys = [
  "version",
  "catalogRevision",
  "queryHash",
  "audience",
  "pageSize",
  "offset",
  "bindingHash",
] as const;

export interface SkillSearchPage {
  readonly items: readonly {
    readonly skillId: string;
    readonly name: string;
    readonly description: string;
  }[];
  readonly nextCursor?: string;
  readonly inventoryComplete: boolean;
}

export interface SearchSkillCatalogInput {
  readonly catalog: SkillCatalogSearchSource;
  readonly query: string;
  readonly cursor?: string;
  readonly pageSize: number;
  readonly audience: SkillInvocationAudience;
  /** Run identity for MODEL cursors; USER catalog cursors can omit this value. */
  readonly cursorBinding?: string;
}

interface CursorValue {
  readonly version: 1;
  readonly catalogRevision: string;
  readonly queryHash: string;
  readonly audience: SkillInvocationAudience;
  readonly pageSize: number;
  readonly offset: number;
  readonly bindingHash: string;
}

export class InvalidSkillSearchCursorError extends Error {
  constructor() {
    super("The Skill search cursor is invalid for this catalog query.");
    this.name = "InvalidSkillSearchCursorError";
  }
}

export function searchSkillCatalog(input: SearchSkillCatalogInput): SkillSearchPage {
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
    throw new RangeError("Skill search page size must be between 1 and 100.");
  }
  if (input.audience !== "USER" && input.audience !== "MODEL") {
    throw new TypeError("Skill search audience is invalid.");
  }
  if (input.cursorBinding !== undefined && Buffer.byteLength(input.cursorBinding, "utf8") > 512) {
    throw new RangeError("Skill search cursor binding exceeds its bounded length.");
  }
  const normalizedQuery = normalizeSkillSearchText(input.query);
  const queryTerms = querySkillSearchTerms(input.query);
  const queryHash = digest(normalizedQuery);
  const bindingHash = digest(input.cursorBinding ?? "");
  const entries = projectSkillCatalogSearchEntries(input.catalog)
    .filter(
      (entry) =>
        entry.enabled && (input.audience === "MODEL" ? entry.modelInvocable : entry.userInvocable),
    )
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, normalizedQuery, queryTerms),
    }))
    .filter(({ score }) => normalizedQuery.length === 0 || score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodePoints(left.entry.name, right.entry.name) ||
        compareCodePoints(left.entry.skillId, right.entry.skillId),
    );

  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (
    cursor !== undefined &&
    (cursor.catalogRevision !== input.catalog.revision ||
      cursor.queryHash !== queryHash ||
      cursor.audience !== input.audience ||
      cursor.pageSize !== input.pageSize ||
      cursor.bindingHash !== bindingHash ||
      cursor.offset >= entries.length)
  ) {
    throw new InvalidSkillSearchCursorError();
  }

  const start = cursor?.offset ?? 0;
  const end = Math.min(start + input.pageSize, entries.length);
  const nextCursor =
    end < entries.length
      ? encodeCursor({
          version: 1,
          catalogRevision: input.catalog.revision,
          queryHash,
          audience: input.audience,
          pageSize: input.pageSize,
          offset: end,
          bindingHash,
        })
      : undefined;
  const items = entries.slice(start, end).map(({ entry }) =>
    Object.freeze({
      skillId: entry.skillId,
      name: entry.name,
      description: entry.description,
    }),
  );
  return Object.freeze({
    items: Object.freeze(items),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    inventoryComplete: input.catalog.complete,
  });
}

function scoreEntry(
  entry: ReturnType<typeof projectSkillCatalogSearchEntries>[number],
  normalizedQuery: string,
  queryTerms: readonly string[],
): number {
  if (normalizedQuery.length === 0) return 0;
  const normalizedName = normalizeSkillSearchText(entry.name);
  const normalizedCorpus = normalizeSkillSearchText(
    [entry.name, entry.displayName ?? "", entry.description, ...entry.searchTerms].join(" "),
  );
  let score = 0;
  if (normalizedName === normalizedQuery) score += 10_000;
  else if (normalizedName.includes(normalizedQuery)) score += 5_000;
  if (normalizedCorpus.includes(normalizedQuery)) score += 2_000;

  if (queryTerms.length === 0) return score;
  const candidateTerms = skillSearchCorpusTerms(normalizedCorpus);
  let matchedTerms = 0;
  for (const term of queryTerms) {
    if (!candidateTerms.has(term)) continue;
    matchedTerms += 1;
    score += Math.min(100, Array.from(term).length) + 1;
  }
  return matchedTerms === 0 && score < 2_000 ? 0 : score;
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(encoded: string): CursorValue {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new InvalidSkillSearchCursorError();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidSkillSearchCursorError();
    }
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).length !== cursorKeys.length ||
      Object.keys(value).some((key) => !(cursorKeys as readonly string[]).includes(key)) ||
      value.version !== 1 ||
      typeof value.catalogRevision !== "string" ||
      value.catalogRevision.length === 0 ||
      value.catalogRevision.length > 256 ||
      typeof value.queryHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.queryHash) ||
      (value.audience !== "USER" && value.audience !== "MODEL") ||
      !Number.isSafeInteger(value.pageSize) ||
      (value.pageSize as number) < 1 ||
      (value.pageSize as number) > 100 ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 1 ||
      typeof value.bindingHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.bindingHash)
    ) {
      throw new InvalidSkillSearchCursorError();
    }
    return value as unknown as CursorValue;
  } catch (error) {
    if (error instanceof InvalidSkillSearchCursorError) throw error;
    throw new InvalidSkillSearchCursorError();
  }
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
