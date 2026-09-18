import type { AIErrorCode } from "@caelush/ai";
import { isRetryableModelTurnErrorCode, toModelTurnExecutionErrorCode } from "@caelush/agent";
import type { ModelTurnExecutionError } from "@caelush/agent";

/**
 * The Core compatibility boundary's thrown-failure projection.
 *
 * ```text
 * AIError.code   → frozen ModelTurnExecutionErrorCode
 * anything else  → PROVIDER_ERROR
 * message        → one generic, sanitized sentence
 * ```
 *
 * It exists because the legacy Core `AgentLoop` drives the frozen `AgentLoop.advance()` over a
 * *throw-based* executor, so a throw has to be translated into the union the frozen loop expects. The
 * thrown message never crosses: a legacy throw may quote a provider body, a prompt or a credential.
 *
 * Phase 3F moved it out of `legacy-model-turn-executor.ts`. The facade was importing the legacy
 * *executor implementation* to reach one pure function, which is exactly the dependency the migration
 * is trying to delete; the mapping now has a module that owns nothing else.
 *
 * It is deliberately defensive in a way `@caelush/agent`'s own projection is not: that one maps an
 * `AIError` instance, this one maps *any* object carrying a string `code`, which is the shape a
 * third-party or legacy transport throw actually has. The classification is therefore identical for
 * every `AIError` and strictly more permissive for everything else.
 *
 * ```text
 * COMPATIBILITY — not the canonical general projection
 * ```
 *
 * CONVERGENCE CONDITION: when the legacy Core `AgentLoop` facade is deleted (its production execution
 * consumer count is already zero), this module goes with it and the frozen executor's own projection is
 * the only one left. It must not be reconciled before then: `@caelush/agent`'s projection prefers
 * `AIError.message` where this one always uses the generic sentence, so merging them would change the
 * legacy facade's observable error text — a public-contract change, which
 * `MIGRATION_EXECUTION_CONTRACT.md` Rule 10 and Rule 5 forbid inside a migration unit.
 */
export function toModelTurnExecutionError(error: unknown): ModelTurnExecutionError {
  const code = readAIErrorCode(error);
  const mapped = code === undefined ? "PROVIDER_ERROR" : toModelTurnExecutionErrorCode(code);
  const retryAfterMs = readRetryAfterMs(error);
  return {
    code: mapped,
    message: "The model turn failed.",
    retryable: isRetryableModelTurnErrorCode(mapped),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function readAIErrorCode(error: unknown): AIErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = (error as { readonly code?: unknown }).code;
  return typeof candidate === "string" ? (candidate as AIErrorCode) : undefined;
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = (error as { readonly retryAfterMs?: unknown }).retryAfterMs;
  return typeof candidate === "number" ? candidate : undefined;
}
