import type { JsonObject } from "@caelush/ai";

/**
 * One transient progress update published by a running Tool.
 *
 * ```text
 * OUTPUT    a chunk of process/file output: stdout or stderr
 * PROGRESS  a bounded progress message, optionally with a completed/total pair
 * STATUS    a bounded status message, optionally with structured details
 * ```
 *
 * Every update is **transient**. It never enters the durable ToolObservation, never becomes model
 * history and never changes durable truth: the final validated result is the only Tool fact the
 * model and recovery ever see. Updates exist so a UI can show something while a long command runs,
 * not so a Tool can commit state out of band.
 */
export type ToolExecutionUpdate =
  | {
      readonly kind: "OUTPUT";
      readonly stream: "stdout" | "stderr";
      readonly chunk: string;
    }
  | {
      readonly kind: "PROGRESS";
      readonly message: string;
      readonly completed?: number | undefined;
      readonly total?: number | undefined;
    }
  | {
      readonly kind: "STATUS";
      readonly message: string;
      readonly details?: JsonObject | undefined;
    };

/**
 * The sink a Tool publishes transient updates through.
 *
 * ```ts
 * publish(update: ToolExecutionUpdate): void;
 * ```
 *
 * `publish` is synchronous on purpose: Tool execution must not await UI transport. The executor owns
 * the queue, the sanitizer and the drain-before-terminal-event ordering behind this port, so a Tool
 * cannot hold the pipeline open with a slow consumer.
 *
 * A sink becomes inert once the Tool's `execute()` promise settles. Later updates are orphaned and
 * dropped silently rather than being attributed to a settled invocation.
 */
export interface ToolExecutionUpdateSink {
  publish(update: ToolExecutionUpdate): void;
}

/** A sink that drops everything. Useful for tools invoked with no progress consumer. */
export const DISCARDING_TOOL_EXECUTION_UPDATE_SINK: ToolExecutionUpdateSink = Object.freeze({
  publish(): void {
    // Transient updates have no durable meaning, so discarding them is always safe.
  },
});
