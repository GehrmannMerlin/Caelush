import type {
  TransientToolUpdateConsumer,
  ToolExecutionUpdate,
  ToolExecutionUpdateSanitizerPort,
} from "@caelush/agent";
import { redactText } from "./secret-redaction.js";
import { classifySensitivePath } from "./sensitive-path.js";

/**
 * The production transient Tool update sanitizer.
 *
 * ```text
 * raw ToolExecutionUpdate
 *   ↓  shape check          a malformed update is dropped, never forwarded
 *   ↓  absolute-path guard  a host path is never shown to a UI
 *   ↓  secret redaction     the same primitives the final result sanitizer uses
 *   ↓  byte bound           a transient update is bounded far more tightly than a final result
 *   ↓  sanitized update, or null
 * ```
 *
 * This is **not** Security V2 and not the Security Gate: it is a compatibility implementation of the
 * Agent layer's `ToolExecutionUpdateSanitizerPort`, so the new executor can protect transient output
 * with the redaction primitives that already exist. Admission and approval remain untouched and stay
 * in Phase 4C.
 *
 * ## Failure is cheap here, and that is the design
 *
 * A final result that cannot be sanitized blocks settlement, because no safe durable observation can
 * be written. An update is different: nothing durable depends on it, so an update that cannot be
 * proven safe is **dropped** and the Tool keeps running. The one thing this port must never do is
 * forward the raw update as a fallback — an unsanitized chunk on its way to a UI is exactly the leak
 * the port exists to prevent.
 *
 * ## Why there is no file-content policy here
 *
 * `search_text` and `patched` file *content* redaction is a result concern: it needs the Tool's
 * arguments and its structured match list. An update carries a chunk of stream output and no context,
 * so this implementation applies the content-independent rules only — secret patterns and host paths.
 * A stronger update policy would need information this layer does not have, and inventing it would be
 * the "permissive fallback" this port forbids.
 */

/** The bound applied to one transient update. Deliberately far below the durable result bound. */
export const MAX_TRANSIENT_UPDATE_BYTES = 8 * 1024;
/** Maximum raw semantic update accepted before safe projection; larger values are dropped. */
export const MAX_TRANSIENT_UPDATE_INPUT_BYTES = 256 * 1024;

/** Absolute Windows drive, UNC and POSIX host paths, as seen in tool output. */
const HOST_PATH =
  /(?:[A-Za-z]:[\\/]{1,2}|\\\\[^\s\\/]+[\\/]|\/(?:Users|home|root|var|etc|opt|tmp)\/)/;

export class CaelushToolExecutionUpdateSanitizer implements ToolExecutionUpdateSanitizerPort {
  sanitize(input: {
    readonly toolName: import("@caelush/protocol").ToolName;
    readonly invocation: import("@caelush/protocol").ToolInvocation;
    readonly update: ToolExecutionUpdate;
  }): ToolExecutionUpdate | null {
    const { update } = input;
    if (update === null || typeof update !== "object") return null;

    switch (update.kind) {
      case "OUTPUT": {
        if (update.stream !== "stdout" && update.stream !== "stderr") return null;
        if (typeof update.chunk !== "string") return null;
        const chunk = this.#safeText(update.chunk);
        return chunk === null
          ? null
          : Object.freeze({ kind: "OUTPUT", stream: update.stream, chunk });
      }
      case "PROGRESS": {
        if (typeof update.message !== "string") return null;
        const message = this.#safeText(update.message);
        if (message === null) return null;
        return Object.freeze({
          kind: "PROGRESS",
          message,
          ...(typeof update.completed === "number" && Number.isFinite(update.completed)
            ? { completed: update.completed }
            : {}),
          ...(typeof update.total === "number" && Number.isFinite(update.total)
            ? { total: update.total }
            : {}),
        });
      }
      case "STATUS": {
        if (typeof update.message !== "string") return null;
        const message = this.#safeText(update.message);
        if (message === null) return null;
        return Object.freeze({ kind: "STATUS", message });
      }
      default:
        return null;
    }
  }

  sanitizeMany(input: {
    readonly toolName: import("@caelush/protocol").ToolName;
    readonly invocation: import("@caelush/protocol").ToolInvocation;
    readonly update: ToolExecutionUpdate;
  }): readonly ToolExecutionUpdate[] {
    const { update } = input;
    if (update === null || typeof update !== "object") return [];
    switch (update.kind) {
      case "OUTPUT": {
        if (update.stream !== "stdout" && update.stream !== "stderr") return [];
        const safe = this.#safeSemanticText(update.chunk);
        return safe === null
          ? []
          : splitTransientUpdateText(safe).map((chunk) =>
              Object.freeze({ kind: "OUTPUT", stream: update.stream, chunk }),
            );
      }
      case "PROGRESS": {
        const safe = this.#safeSemanticText(update.message);
        return safe === null
          ? []
          : splitTransientUpdateText(safe).map((message, index) =>
              Object.freeze({
                kind: "PROGRESS",
                message,
                ...(index === 0 &&
                typeof update.completed === "number" &&
                Number.isFinite(update.completed)
                  ? { completed: update.completed }
                  : {}),
                ...(index === 0 && typeof update.total === "number" && Number.isFinite(update.total)
                  ? { total: update.total }
                  : {}),
              }),
            );
      }
      case "STATUS": {
        const safe = this.#safeSemanticText(update.message);
        return safe === null
          ? []
          : splitTransientUpdateText(safe).map((message) =>
              Object.freeze({ kind: "STATUS", message }),
            );
      }
      default:
        return [];
    }
  }

  /**
   * Redact, refuse a host path, and bound.
   *
   * `null` means "this update cannot be represented safely", which the executor turns into a drop.
   */
  #safeText(value: string): string | null {
    const safe = this.#safeSemanticText(value);
    return safe === null ? null : boundTransientUpdateText(safe);
  }

  #safeSemanticText(value: string): string | null {
    if (typeof value !== "string") return null;
    if (Buffer.byteLength(value, "utf8") > MAX_TRANSIENT_UPDATE_INPUT_BYTES) return null;
    if (HOST_PATH.test(value)) return null;
    const redacted = redactText(value);
    if (HOST_PATH.test(redacted)) return null;
    return redacted;
  }
}

/** Bound a transient update to whole characters within `MAX_TRANSIENT_UPDATE_BYTES`. */
export function boundTransientUpdateText(
  value: string,
  maxBytes = MAX_TRANSIENT_UPDATE_BYTES,
): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(prefix + character, "utf8") > maxBytes) break;
    prefix += character;
  }
  return prefix;
}

/** Split already-sanitized text on whole Unicode code points and UTF-8 byte boundaries. */
export function splitTransientUpdateText(
  value: string,
  maxBytes = MAX_TRANSIENT_UPDATE_BYTES,
): readonly string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (current.length > 0 && Buffer.byteLength(`${current}${character}`, "utf8") > maxBytes) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** True when a path a Tool touched is one whose content must not be shown. */
export function isSensitiveToolPath(value: unknown): boolean {
  return typeof value === "string" && classifySensitivePath(value) !== undefined;
}

/**
 * The transient consumer the production composition uses until a host has a real ephemeral transport.
 *
 * Discarding is the correct default: the update semantics, the sanitizer and the ordering guarantees
 * are all exercised by tests, and nothing is delivered anywhere it could leak. Phase 4E wires actual
 * Coding builtin progress, and product transport (SSE, timeline, CLI) belongs to the UI layer.
 */
export const DISCARDING_TOOL_UPDATE_CONSUMER: TransientToolUpdateConsumer = Object.freeze({
  publish(): void {
    // A transient update has no durable meaning, so discarding it is always safe.
  },
});
