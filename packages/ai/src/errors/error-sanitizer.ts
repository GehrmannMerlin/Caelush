import { assertAISerializableError } from "./serializable-error.js";
import type { AIError } from "./ai-error.js";
import type { AISerializableError } from "./serializable-error.js";

/**
 * Turn an AI failure into its safe transportable form.
 *
 * The sanitizer is the AI boundary's last line of defence: it removes credential
 * material from the message, and it copies only the frozen serializable fields,
 * so a cause, a stack, raw headers or a raw provider body can never travel with
 * the error.
 */
export interface AIErrorSanitizer {
  sanitize(error: AIError): AISerializableError;
}

/** Options for {@link createAIErrorSanitizer}. */
export interface CreateAIErrorSanitizerOptions {
  /**
   * Credential values this process knows about.
   *
   * A value listed here is replaced wherever it appears, even outside a
   * credential position. Phase 2B wires the credentials resolved during
   * preflight in here; Phase 2A ships the mechanism, not the wiring.
   */
  readonly knownSecrets?: readonly string[];
}

/** The frozen replacement marker. */
export const REDACTED = "[REDACTED]";

/**
 * Credential keywords that make the value after them a secret.
 *
 * Matched case-insensitively, with `-` and `_` treated as separators.
 */
const CREDENTIAL_KEYWORD =
  "(?:authorization|x[_-]?api[_-]?key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|credential|credentials|bearer)";

/** `keyword`, then a separator, then an optionally quoted value. */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  `(${CREDENTIAL_KEYWORD}\\s*[:=]\\s*)(["']?)([^\\s,;"'}\\]]+)(\\2)`,
  "gi",
);

/** The `Bearer <token>` scheme, including `Authorization: Bearer <token>`. */
const BEARER_SCHEME = new RegExp(`(\\bbearer\\s+)([A-Za-z0-9._~+/=-]{4,})`, "gi");

/**
 * Recognisable provider credential shapes.
 *
 * A high-confidence prefix is enough to treat the token as a secret even with no
 * keyword in front of it.
 */
const CREDENTIAL_SHAPED_TOKEN =
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|glpat|hf|xox[abpsr]|AKIA|ASIA|AIza|ya29)[-_A-Za-z0-9]{12,}\b/g;

/**
 * Remove credential material from AI-authored text.
 *
 * Deterministic and pure. This is high-confidence redaction, not complete DLP
 * coverage: it removes secrets that appear in a credential position, that carry
 * a recognisable credential shape, or that the caller declared as known.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let redacted = text;

  // Longest first, so a secret that contains another known secret is fully removed.
  const secrets = [...new Set(knownSecrets)]
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }

  return redacted
    .replace(BEARER_SCHEME, `$1${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1$2${REDACTED}$4`)
    .replace(CREDENTIAL_SHAPED_TOKEN, REDACTED);
}

/** Create the default sanitizer. */
export function createAIErrorSanitizer(
  options: CreateAIErrorSanitizerOptions = {},
): AIErrorSanitizer {
  const knownSecrets = options.knownSecrets ?? [];

  return {
    sanitize(error: AIError): AISerializableError {
      const serializable: {
        code: AIError["code"];
        message: string;
        providerId?: string;
        model?: AIError["model"];
        retryable: boolean;
        retryAfterMs?: number;
      } = {
        code: error.code,
        message: redactSecrets(error.message, knownSecrets),
        retryable: error.retryable,
      };

      if (error.providerId !== undefined) serializable.providerId = error.providerId;
      if (error.model !== undefined) serializable.model = error.model;
      if (error.retryAfterMs !== undefined) serializable.retryAfterMs = error.retryAfterMs;

      assertAISerializableError(serializable);
      return serializable;
    },
  };
}
