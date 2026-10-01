import type { JsonObject } from "@caelush/ai";
import type { RunId } from "@caelush/protocol";
import type { ToolExecutionEnvironment, ToolSecurityContext } from "@caelush/agent";

/**
 * Write to, or poll, a running process.
 *
 * ```ts
 * export interface ProcessOperations {
 *   interact(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly ownerRunId: RunId;
 *     readonly sessionId: string;
 *     readonly chars: string;
 *     readonly yieldTimeMs: number;
 *     readonly signal: AbortSignal;
 *     readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
 *   }): Promise<JsonObject>;
 * }
 * ```
 *
 * ## Empty `chars` is a poll, not a no-op
 *
 * `chars: ""` means "show me whatever the process produced since I last looked". That is the same call
 * path as a write, and it is why this port is not named `WriteStdinOperations`: the operation is
 * *interaction*, and a write is one case of it.
 *
 * ## `ownerRunId` enforces ownership
 *
 * A session id is opaque, so the only safe way to decide whether a caller may touch a process is the
 * Run that started it. The Runtime checks that this `ownerRunId` owns `sessionId`; a mismatch is a
 * stale or foreign session and never a silent write into somebody else's process.
 *
 * ## Uncertainty is preserved
 *
 * An interact against a session whose state can no longer be proven must not be downgraded into
 * "session not found". The Runtime raises dedicated stale-session and uncertain-process errors, and the
 * adapter lets them through so the Coding Tool can map them onto the canonical uncertain-side-effect
 * vocabulary. Reporting a *known* not-found is reserved for a session the Runtime can prove does not
 * exist.
 */
export interface ProcessOperations {
  interact(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly securityContext?: ToolSecurityContext | undefined;

    readonly ownerRunId: RunId;

    readonly sessionId: string;

    readonly chars: string;

    readonly yieldTimeMs: number;

    readonly signal: AbortSignal;

    readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  }): Promise<JsonObject>;

  /**
   * Terminate one managed process session this Run owns.
   *
   * ```ts
   * terminate(input: {
   *   readonly environment: ToolExecutionEnvironment;
   *   readonly ownerRunId: RunId;
   *   readonly sessionId: string;
   * }): Promise<JsonObject>
   * ```
   *
   * ## The input is a session handle, and nothing else
   *
   * No pid, no image name, no pattern, no wildcard and no `all`. Those are exactly the forms whose
   * ownership a shell cannot prove, and admitting one here would recreate the bypass this operation
   * exists to remove. `sessionId` is opaque and Runtime-minted, so the Runtime can always answer
   * "does the calling Run own this?" — which no external identifier allows.
   *
   * ## Ownership is checked by the Runtime, never by the caller
   *
   * The Tool supplies its own Run identity and the Runtime rejects a session another Run started.
   * A foreign session is reported as not-found rather than forbidden, so the operation never tells
   * one Run who owns another Run's process.
   *
   * ## Uncertainty is preserved
   *
   * A termination whose outcome cannot be confirmed is an uncertain side effect, not a failed call,
   * for the same reason a stale interaction is: a model that reads "not found" will simply start the
   * command again, which is the duplicate execution the uncertain vocabulary exists to prevent.
   */
  terminate(input: {
    readonly environment: ToolExecutionEnvironment;
    readonly securityContext?: ToolSecurityContext | undefined;

    readonly ownerRunId: RunId;

    readonly sessionId: string;
  }): Promise<JsonObject>;
}
