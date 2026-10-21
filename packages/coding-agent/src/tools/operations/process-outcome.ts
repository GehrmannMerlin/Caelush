/** JSON-safe outcome of one observed Runtime process result. */
export type ProcessOutcome =
  | { readonly kind: "RUNNING" }
  | { readonly kind: "EXITED_OK"; readonly exitCode: 0 }
  | { readonly kind: "EXITED_NONZERO"; readonly exitCode: number }
  | { readonly kind: "TERMINATED"; readonly signal?: string }
  | { readonly kind: "UNKNOWN" };

/**
 * Project only the Runtime-owned process fields that prove an outcome.
 * Invocation completion says the observation was saved; it does not turn a non-zero exit into success.
 */
export function projectProcessOutcome(value: unknown): ProcessOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "UNKNOWN" };
  }
  const record = value as Record<string, unknown>;
  if (record["status"] === "RUNNING") return { kind: "RUNNING" };
  if (record["status"] !== "EXITED") return { kind: "UNKNOWN" };

  const signal = typeof record["signal"] === "string" ? record["signal"] : undefined;
  if (signal !== undefined) {
    return { kind: "TERMINATED", signal };
  }
  const exitCode = record["exitCode"];
  if (!Number.isSafeInteger(exitCode)) return { kind: "UNKNOWN" };
  if (exitCode === 0) return { kind: "EXITED_OK", exitCode: 0 };
  if (typeof exitCode === "number") return { kind: "EXITED_NONZERO", exitCode };
  return { kind: "UNKNOWN" };
}
