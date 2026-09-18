import type { JsonObject } from "@caelush/ai";

import type { ToolExecutionEnvironment } from "./execution-environment.js";
import type { ToolExecutionIdentity } from "./execution-identity.js";
import type { ToolExecutionUpdateSink } from "./tool-update.js";

/**
 * Everything a Tool execution receives.
 *
 * ```text
 * identity     who this execution is
 * args         the prepared, schema-validated arguments
 * environment  the compatibility execution locator
 * signal       the caller's cancellation signal — required
 * updates      the transient update sink — required
 * ```
 *
 * Nothing else is passed. A Tool does not receive a Run, a Workspace object, a Runtime scope, a
 * Storage service, an approval repository, a model client or an EventBus: environment capabilities
 * arrive through narrow Operations interfaces that the Tool's own factory closes over.
 *
 * ## Why `signal` is required
 *
 * Cancellation must exist on every hop from Run cancellation to the Runtime operation. If the
 * signal were optional, each Tool would have to invent its own `undefined` story and one of them
 * would get it wrong. The coordinator therefore always supplies a signal, creating a non-aborted
 * internal one when the caller has none, and a Tool simply forwards it.
 *
 * ## Why `updates` is required
 *
 * Progress is published, never awaited. A required sink means a Tool never branches on "is anyone
 * listening"; a host with no progress consumer supplies a discarding sink.
 */
export interface AgentToolExecutionInput<TArgs extends JsonObject = JsonObject> {
  readonly identity: ToolExecutionIdentity;
  readonly args: TArgs;
  readonly environment: ToolExecutionEnvironment;
  /** Required by contract. Run cancellation reaches the Runtime operation through this value. */
  readonly signal: AbortSignal;
  /** Required by contract. Transient progress only; it never becomes durable truth. */
  readonly updates: ToolExecutionUpdateSink;
}
