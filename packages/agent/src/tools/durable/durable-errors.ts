/**
 * The durable Tool lifecycle errors.
 *
 * ```text
 * ToolExecutionConflictError    a writer lost the race; the caller must re-read, never blind-retry
 * ToolExecutionInvariantError   durable state contradicts the lifecycle contract
 * ```
 *
 * ## One class, one identity
 *
 * Phase 4C moved the durable Tool store contract into `@caelush/agent`, and the error identity moved
 * with it. Phase 4F deleted the legacy `@caelush/tools` package, including the re-exports that had
 * kept its old error names alive, so these classes are now the only declarations.
 *
 * That matters because callers catch these by identity. A second class with the same name would make
 * `error instanceof ToolExecutionConflictError` silently false for one of the two, and a lost
 * conflict is a blind retry on a row another writer already moved.
 *
 * ## Which is which
 *
 * A **conflict** is expected and recoverable by re-reading: the revision moved, the external call
 * already exists with a different identity, an event sequence collided. It propagates to the caller
 * unchanged, because only the caller knows whether re-reading is safe.
 *
 * An **invariant** failure is a broken contract, not a race: a terminal invocation without its
 * observation, an approval that does not belong to its invocation, a budget owner that is not the
 * invocation. It is a defect signal and never becomes a model-facing Tool result.
 */

export class ToolExecutionConflictError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ToolExecutionConflictError";
  }
}

export class ToolExecutionInvariantError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ToolExecutionInvariantError";
  }
}
