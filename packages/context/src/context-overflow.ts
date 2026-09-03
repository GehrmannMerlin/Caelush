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

export function isContextOverflowError(error: unknown): boolean {
  return (
    error instanceof ContextOverflowError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (["CONTEXT_OVERFLOW", "LLM_CONTEXT_OVERFLOW"] as readonly unknown[]).includes(
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
