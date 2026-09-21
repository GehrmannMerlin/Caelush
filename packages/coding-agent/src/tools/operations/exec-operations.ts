import type { JsonObject } from "@caelush/ai";
import type { RunId } from "@caelush/protocol";
import type { ToolExecutionEnvironment } from "@caelush/agent";

/**
 * Start a command.
 *
 * ```ts
 * export interface ExecOperations {
 *   execute(input: {
 *     readonly environment: ToolExecutionEnvironment;
 *     readonly ownerRunId: RunId;
 *     readonly command: string;
 *     readonly workdir?: string;
 *     readonly tty: boolean;
 *     readonly yieldTimeMs: number;
 *     readonly signal: AbortSignal;
 *     readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
 *   }): Promise<JsonObject>;
 * }
 * ```
 *
 * ## `ownerRunId`
 *
 * A started process is owned by the Run that started it. Passing the Run identity at the operation
 * boundary is what lets the Runtime enforce same-Run session ownership for a later `write_stdin`, and
 * what lets Run-scoped cleanup stop only the processes this Run owns.
 *
 * ## `yieldTimeMs` is observation wait, not a timeout
 *
 * It says how long the caller is willing to wait before being told "still running". It never kills the
 * process, and nothing in this contract implements a timeout. The Tool validates it against its own
 * bounds before it gets here.
 *
 * ## `onOutput` — reserved, and honest about it
 *
 * The callback is part of the contract so that a Tool can publish transient output as it arrives. The
 * first Runtime adapter has **no live streaming source**: `RuntimeExecService.execute()` is a
 * yield-and-return call, so the production adapter does not invoke `onOutput` at all. It does not
 * poll to fabricate chunks and does not claim realtime output. The seam exists so that a Runtime which
 * later gains a live stream needs no Tool change, and a fake Operations implementation in a unit test
 * can already prove the Tool projects the callback onto the canonical transient-update channel.
 *
 * ## The return is a `JsonObject`
 *
 * Deliberately structural rather than a promoted Runtime type: the Runtime's exec result schema is
 * still evolving, and the frozen boundary here is the *capability*, not the result vocabulary. The
 * Tool reads the fields it needs from the returned object.
 */
export interface ExecOperations {
  execute(input: {
    readonly environment: ToolExecutionEnvironment;

    readonly ownerRunId: RunId;

    readonly command: string;

    readonly workdir?: string;

    readonly tty: boolean;

    readonly yieldTimeMs: number;

    readonly signal: AbortSignal;

    readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  }): Promise<JsonObject>;
}
