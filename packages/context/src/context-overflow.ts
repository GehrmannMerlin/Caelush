export class ContextOverflowError extends Error {
  readonly code = "CONTEXT_OVERFLOW" as const;

  constructor() {
    super("The provider rejected the request because its context window was exceeded.");
    this.name = "ContextOverflowError";
  }
}

export class ContextExhaustedError extends Error {
  readonly code = "CONTEXT_EXHAUSTED" as const;

  constructor() {
    super("The model context could not be recovered after compaction.");
    this.name = "ContextExhaustedError";
  }
}

/**
 * The provider-context-overflow signal, in every spelling the runtime may produce.
 *
 * `CONTEXT_OVERFLOW` and `LLM_CONTEXT_OVERFLOW` are the legacy Context/LLM spellings.
 * `AI_CONTEXT_OVERFLOW` is the Architecture V2 AI-core spelling, and since Phase 2C the
 * agent model turn is executed by the AI core, so it is the one a real provider
 * overflow now arrives as. All three describe the same condition, and exactly one
 * recovery is allowed in `recoverProviderContextOverflow`.
 */
const CONTEXT_OVERFLOW_CODES = [
  "CONTEXT_OVERFLOW",
  "LLM_CONTEXT_OVERFLOW",
  "AI_CONTEXT_OVERFLOW",
] as const;

export function isContextOverflowError(error: unknown): boolean {
  return (
    error instanceof ContextOverflowError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (CONTEXT_OVERFLOW_CODES as readonly unknown[]).includes(
        (error as { readonly code?: unknown }).code,
      ))
  );
}

export interface ContextOverflowRecoveryInput<T> {
  readonly execute: () => Promise<T>;
  readonly forceCompact: () => Promise<void>;
  readonly rehydrate: () => Promise<void>;
}

export interface ContextOverflowRecoveryResult<T> {
  readonly value: T;
  readonly recovered: boolean;
}

export async function recoverProviderContextOverflow<T>(
  input: ContextOverflowRecoveryInput<T>,
): Promise<ContextOverflowRecoveryResult<T>> {
  try {
    return { value: await input.execute(), recovered: false };
  } catch (error) {
    if (!isContextOverflowError(error)) throw error;
    await input.forceCompact();
    await input.rehydrate();
    try {
      return { value: await input.execute(), recovered: true };
    } catch (retryError) {
      if (isContextOverflowError(retryError)) throw new ContextExhaustedError();
      throw retryError;
    }
  }
}
