const MAX_QUERY_CODE_POINTS = 256;
const MAX_TERMS = 64;
const MAX_CJK_RUN_CODE_POINTS = 64;
const MAX_EXPLICIT_SEARCH_TERMS = 64;
const MAX_EXPLICIT_TERM_CODE_POINTS = 128;

const EXPLICIT_TERM_KEYS = new Set(["searchterms", "keywords"]);

const CHINESE_SYNONYMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["优化页面", ["frontend", "design", "web", "page", "pages", "website", "ui", "interface"]],
  ["页面优化", ["frontend", "design", "web", "page", "pages", "website", "ui", "interface"]],
  ["优化界面", ["frontend", "design", "web", "ui", "interface", "polish"]],
  ["美化页面", ["frontend", "design", "web", "page", "pages", "ui", "interface"]],
  ["前端", ["frontend", "front end", "web", "website"]],
  ["网页", ["web", "website", "web page", "frontend"]],
  ["页面", ["page", "pages", "web page", "website", "frontend"]],
  ["界面", ["ui", "interface", "frontend"]],
  ["设计", ["design", "layout", "ui"]],
  ["优化", ["optimize", "improve", "polish"]],
  ["数据库迁移", ["database", "db", "schema", "migration", "migrate"]],
  ["数据库", ["database", "db", "sql"]],
  ["迁移", ["migration", "migrate"]],
];

export function normalizeSkillSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

export function querySkillSearchTerms(query: string): readonly string[] {
  const normalized = normalizeSkillSearchText(query);
  if (Array.from(normalized).length > MAX_QUERY_CODE_POINTS) {
    throw new RangeError("Skill search query exceeds its bounded length.");
  }
  const terms = new Set<string>();
  addTokenizedTerms(terms, normalized);
  for (const [phrase, translations] of CHINESE_SYNONYMS) {
    if (normalized.includes(phrase)) {
      addTokenizedTerms(terms, phrase);
      for (const translation of translations) addTokenizedTerms(terms, translation);
    }
  }
  return Object.freeze([...terms].slice(0, MAX_TERMS));
}

export function skillSearchCorpusTerms(value: string): ReadonlySet<string> {
  const terms = new Set<string>();
  addTokenizedTerms(terms, normalizeSkillSearchText(value));
  return terms;
}

export function parseExplicitSkillSearchTerms(
  metadata: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (metadata === undefined) return Object.freeze([]);
  const values = Object.entries(metadata)
    .filter(([key]) =>
      EXPLICIT_TERM_KEYS.has(key.normalize("NFKC").toLowerCase().replace(/[-_]/gu, "")),
    )
    .sort(([left], [right]) => compareCodePoints(left, right))
    .flatMap(([, value]) => value.split(/[,，;；|\n\r]+/u));
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSkillSearchText(value);
    if (normalized.length === 0 || Array.from(normalized).length > MAX_EXPLICIT_TERM_CODE_POINTS) {
      continue;
    }
    terms.add(normalized);
    if (terms.size >= MAX_EXPLICIT_SEARCH_TERMS) break;
  }
  return Object.freeze([...terms]);
}

function addTokenizedTerms(target: Set<string>, value: string): void {
  const normalized = normalizeSkillSearchText(value);
  const tokens = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
  for (const token of tokens) {
    if (target.size >= MAX_TERMS) return;
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const points = Array.from(token);
      if (points.length <= MAX_CJK_RUN_CODE_POINTS && points.length > 1) {
        target.add(token);
        for (let index = 0; index < points.length - 1; index += 1) {
          target.add(`${points[index]}${points[index + 1]}`);
          if (target.size >= MAX_TERMS) return;
        }
      } else if (points.length === 1) {
        target.add(token);
      }
      continue;
    }
    target.add(token);
    for (const part of token.split(/[-']/u)) {
      if (target.size >= MAX_TERMS) return;
      if (part.length > 1) target.add(part);
    }
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
