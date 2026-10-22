/**
 * The shared, deliberately boring half of a bounded failure diagnostic.
 *
 * ```text
 * caught exception
 *   → at most four cause links          (a bound, so a cyclic or endless chain cannot grow one)
 *   → each link named by a whitelist    (so a custom class name cannot become a diagnostic surface)
 * ```
 *
 * Two diagnostics in this package need exactly these two operations and nothing else: the Tool
 * failure classifier and the Context preparation classifier. Keeping one implementation means the
 * bound and the whitelist cannot drift apart, and that neither classifier accidentally becomes a
 * place where an exception's *content* is read.
 *
 * Nothing here reads a message, a stack, a property bag or an argument. `readCause` touches exactly
 * one property, and it does so defensively: an accessor that throws must not replace the Run's real
 * failure with the classifier's own.
 */

/** The most cause links one diagnostic may describe. */
export const MAX_DIAGNOSTIC_CAUSE_LINKS = 4;

/**
 * The structural label vocabulary shared by every diagnostic.
 *
 * Only these names can appear through `constructorNameOf`. An unrecognized class is labelled
 * `UnknownCause` rather than by its own name, so an application's naming cannot leak through.
 */
const BUILT_IN_CAUSE_KINDS: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

export const UNKNOWN_CAUSE_KIND = "UnknownCause";

/** The error constructors a bounded diagnostic is allowed to recognize. */
export type CauseErrorConstructor = abstract new (...args: never[]) => Error;

/** One entry of a classifier's private whitelist. Order matters: subclasses come first. */
export interface CauseLabel {
  readonly type: CauseErrorConstructor;
  readonly label: string;
}

/**
 * Collect the cause chain, outermost first, bounded and cycle-safe.
 *
 * Safe for a hostile input: a throwing `cause` accessor, a cyclic chain and a chain longer than the
 * bound all produce a finite list rather than an exception.
 */
export function collectCauseChain(cause: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = cause;
  while (
    current !== null &&
    current !== undefined &&
    chain.length < MAX_DIAGNOSTIC_CAUSE_LINKS &&
    !seen.has(current)
  ) {
    seen.add(current);
    chain.push(current);
    current = readCause(current);
  }
  return chain;
}

/** Name one link: a whitelisted class, a built-in error name, or `UnknownCause`. */
export function causeKindOf(value: unknown, labels: readonly CauseLabel[]): string {
  for (const entry of labels) {
    if (value instanceof entry.type) return entry.label;
  }
  const name = constructorNameOf(value);
  return name !== undefined && BUILT_IN_CAUSE_KINDS.has(name) ? name : UNKNOWN_CAUSE_KIND;
}

/** Reading `cause` may hit an accessor that throws; a broken error must not mask the failure. */
function readCause(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as { readonly cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

function constructorNameOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const ctor = (value as { readonly constructor?: unknown }).constructor;
    const name =
      typeof ctor === "function" ? (ctor as { readonly name?: unknown }).name : undefined;
    return typeof name === "string" && name.length > 0 && name.length <= 64 ? name : undefined;
  } catch {
    return undefined;
  }
}
