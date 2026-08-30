import type { JsonObject, JsonValue } from "@caelush/protocol";

export const MAX_SECRET_SCAN_TEXT_BYTES = 64 * 1024;
export const MAX_SECRET_JSON_DEPTH = 8;
export const MAX_SECRET_JSON_NODES = 1000;

export type SecretCategory =
  | "PRIVATE_KEY"
  | "AUTHORIZATION_HEADER"
  | "API_KEY"
  | "ACCESS_TOKEN"
  | "PASSWORD"
  | "CLIENT_SECRET"
  | "CREDENTIAL"
  | "URL_CREDENTIAL"
  | "CLOUD_ACCESS_KEY"
  | "PROVIDER_TOKEN"
  | "GENERIC_SECRET_ASSIGNMENT"
  | "SCAN_LIMIT";

export interface SecretDetectionReport {
  readonly count: number;
  readonly categories: readonly SecretCategory[];
}

interface RedactionResult {
  readonly value: string;
  readonly count: number;
  readonly categories: ReadonlySet<SecretCategory>;
}

const REDACTED = "[REDACTED]";
const SCAN_LIMIT_REDACTED = "[REDACTED:SCAN_LIMIT]";
const SENSITIVE_KEY = /(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|credential|private[_-]?key|access[_-]?key)/i;
const PLACEHOLDER = /^(?:your[_-]?(?:api[_-]?key|token|secret|password)|<[^>]+>|\$\{[^}]+\}|redacted|changeme|example|placeholder|xxxx)$/i;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER = /(\bAuthorization\s*:\s*Bearer\s+)([^\s,;]+)/gi;
const BASIC = /(\bAuthorization\s*:\s*Basic\s+)([^\s,;]+)/gi;
const QUERY = /([?&](?:token|api[_-]?key|apikey|access[_-]?token|key)=)([^&#\s]+)/gi;
const USERINFO = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const PROVIDER_TOKEN = /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g;
const SECRET_SENTINEL = /\b(?:SECRET|TOKEN|PASSWORD|API_KEY)_[A-Z0-9_]{8,}\b/g;
const ASSIGNMENT = /\b((?:[A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|credential|private[_-]?key|access[_-]?key)|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|credential|private[_-]?key|access[_-]?key))\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;

export function detectSecrets(text: string): SecretDetectionReport {
  const result = redactTextInternal(text);
  return { count: result.count, categories: [...result.categories].sort() };
}

export function redactText(text: string): string {
  return redactTextInternal(text).value;
}

export function redactJson(value: JsonValue | unknown): JsonValue {
  const state = { nodes: 0 };
  return redactJsonValue(value, 0, state);
}

export function redactToolArgumentsForPresentation(args: JsonObject): JsonObject {
  return redactJson(args) as JsonObject;
}

export interface SecretDetector {
  detect(text: string): SecretDetectionReport;
}

export interface SecretRedactor {
  redactText(text: string): string;
  redactJson(value: JsonValue): JsonValue;
}

export const secretDetector: SecretDetector = { detect: detectSecrets };
export const secretRedactor: SecretRedactor = { redactText, redactJson };

function redactTextInternal(text: string): RedactionResult {
  if (typeof text !== "string") return { value: SCAN_LIMIT_REDACTED, count: 1, categories: new Set(["SCAN_LIMIT"]) };
  if (Buffer.byteLength(text, "utf8") > MAX_SECRET_SCAN_TEXT_BYTES) {
    return { value: SCAN_LIMIT_REDACTED, count: 1, categories: new Set(["SCAN_LIMIT"]) };
  }
  let value = text;
  let count = 0;
  const categories = new Set<SecretCategory>();
  const replace = (
    pattern: RegExp,
    category: SecretCategory,
    callback: (...args: string[]) => string,
  ) => {
    value = value.replace(pattern, (...args) => {
      count += 1;
      categories.add(category);
      return callback(...args.slice(0, -2));
    });
  };
  replace(PRIVATE_KEY, "PRIVATE_KEY", () => `${"-----BEGIN PRIVATE KEY-----"}\n${REDACTED}\n-----END PRIVATE KEY-----`);
  replace(BEARER, "AUTHORIZATION_HEADER", (_match, prefix) => `${prefix}${REDACTED}`);
  replace(BASIC, "AUTHORIZATION_HEADER", (_match, prefix) => `${prefix}${REDACTED}`);
  replace(USERINFO, "URL_CREDENTIAL", (match, prefix) => `${prefix}${REDACTED}@`);
  replace(QUERY, "CREDENTIAL", (_match, prefix) => `${prefix}${REDACTED}`);
  replace(PROVIDER_TOKEN, "PROVIDER_TOKEN", () => REDACTED);
  replace(SECRET_SENTINEL, "GENERIC_SECRET_ASSIGNMENT", () => REDACTED);
  value = value.replace(ASSIGNMENT, (match, key: string, separator: string, rawValue: string) => {
    const unquoted = rawValue.replace(/^['"]|['"]$/g, "");
    if (isPlaceholder(unquoted) || unquoted === REDACTED || unquoted === SCAN_LIMIT_REDACTED) return match;
    count += 1;
    categories.add(categoryForKey(key));
    const quote = rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : "";
    return `${key}${separator}${quote}${REDACTED}${quote}`;
  });
  return { value, count, categories };
}

function redactJsonValue(value: unknown, depth: number, state: { nodes: number }): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_SECRET_JSON_NODES || depth > MAX_SECRET_JSON_DEPTH) return SCAN_LIMIT_REDACTED;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, depth + 1, state));
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactJsonValue(item, depth + 1, state);
    }
    return output;
  }
  return SCAN_LIMIT_REDACTED;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

function categoryForKey(key: string): SecretCategory {
  const lower = key.toLowerCase();
  if (lower.includes("password") || lower.includes("passwd")) return "PASSWORD";
  if (lower.includes("api") && lower.includes("key")) return "API_KEY";
  if (lower.includes("access") && lower.includes("token")) return "ACCESS_TOKEN";
  if (lower.includes("client") && lower.includes("secret")) return "CLIENT_SECRET";
  if (lower.includes("credential")) return "CREDENTIAL";
  return "GENERIC_SECRET_ASSIGNMENT";
}
