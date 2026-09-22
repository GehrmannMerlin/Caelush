/**
 * The canonical uncertainty vocabulary.
 *
 * ```text
 * UNCERTAIN_SIDE_EFFECT   the Tool may have partially or fully executed, and nothing can prove
 *                         otherwise
 * ```
 *
 * This is a first-class execution semantic, not a severity label. It exists so the durable shell can
 * record a failure that stops dependent work instead of inviting a retry: an automatic repeat after
 * an unproven side effect is how one patch becomes two, one command becomes two, and one external
 * request becomes two.
 *
 * The declaration lives here rather than in the Coding Tool product layer because the canonical
 * executor must recognize the error a Tool throws, and `@caelush/agent` may not depend on
 * `@caelush/coding-agent`. Phase 4F removed the legacy `@caelush/tools` package that used to re-export
 * both the constant and the error class, so a builtin that throws it imports the one canonical
 * identity from `@caelush/agent` and an `instanceof` check agrees everywhere.
 */
export const UNCERTAIN_SIDE_EFFECT = "UNCERTAIN_SIDE_EFFECT" as const;

/** The disposition a durable failure carries when a Tool's side effect could not be proven. */
export type UncertainSideEffect = typeof UNCERTAIN_SIDE_EFFECT;

/**
 * A Tool states that its side effect could not be verified.
 *
 * ```text
 * a patch may or may not have been applied
 * a process may or may not have started
 * a command's side effects are unknown
 * ```
 *
 * The executor lets this error leave the Tool boundary unchanged, so the durable shell can settle the
 * invocation as `FAILED` with an `UNCERTAIN_SIDE_EFFECT` disposition and the batch can stop. It is
 * never converted into an ordinary `isError: true` result: a model told "the tool failed" would
 * simply try again.
 */
export class ToolExecutionUncertainError extends Error {
  readonly executionDisposition: UncertainSideEffect = UNCERTAIN_SIDE_EFFECT;

  constructor(message = "Tool execution side effects could not be verified safely.") {
    super(message);
    this.name = "ToolExecutionUncertainError";
  }
}

/** True when an error is the canonical uncertain-side-effect failure, whoever threw it. */
export function isToolExecutionUncertainError(value: unknown): boolean {
  return (
    value instanceof ToolExecutionUncertainError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { readonly executionDisposition?: unknown }).executionDisposition ===
        UNCERTAIN_SIDE_EFFECT)
  );
}

/** The durable failure shape an uncertain execution must carry. */
export interface UncertainExecutionDisposition {
  readonly executionDisposition: UncertainSideEffect;
}

/** The detail a durable failure carries for an uncertain execution. */
export function uncertainExecutionDetails(): UncertainExecutionDisposition {
  return { executionDisposition: UNCERTAIN_SIDE_EFFECT };
}
