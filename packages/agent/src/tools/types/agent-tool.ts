import type { AIToolSpec, JsonObject } from "@caelush/ai";

import type { AgentToolExecutionInput } from "./execution-input.js";
import type { ToolExecutionMode } from "./execution-mode.js";
import type { AgentToolResult } from "./tool-result.js";

/**
 * A general, executable Agent Tool.
 *
 * ```ts
 * export interface AgentTool<
 *   TArgs extends JsonObject = JsonObject,
 *   TDetails extends JsonObject = JsonObject,
 * > extends AIToolSpec {
 *   readonly label: string;
 *   readonly resultDetailsSchema: JsonObject;
 *   readonly executionMode: ToolExecutionMode;
 *   readonly prepareArguments?: (rawArgs: Readonly<JsonObject>) => TArgs;
 *   readonly execute: (input: AgentToolExecutionInput<TArgs>) => Promise<AgentToolResult<TDetails>>;
 * }
 * ```
 *
 * Three layers exist and each owns only its own fields:
 *
 * ```text
 * AIToolSpec            name, description, inputSchema     — how the tool is shown to a model
 * AgentTool             + execution and result contract    — how a general tool is run reliably
 * CodingToolDefinition  + security/effects/UI/prompt       — what a Coding product adds
 * ```
 *
 * `AIToolSpec` is reused from `@caelush/ai` rather than restated: there is one AI tool contract, and
 * it stays the model-facing one.
 *
 * ## `resultDetailsSchema` stays on the Tool
 *
 * `inputSchema` is sent to the model; `resultDetailsSchema` is not. It validates the `details` a
 * Tool returns, so a Tool that quietly changes its details contract fails at the boundary instead of
 * corrupting a durable observation.
 *
 * ## `prepareArguments` is compatibility normalization, not validation bypass
 *
 * It exists for a *known, deterministic* provider/model serialization quirk — a numeric string where
 * the schema declares an integer, for example — and nothing else. It must be pure, deterministic,
 * bounded and free of side effects: no file read, no shell, no network, no model call, no database,
 * no user interaction. It may not guess a missing path, invent a command or substitute a default.
 * Schema validation still runs afterwards, on what it returned.
 *
 * A Tool that throws `ToolArgumentPreparationError` states "this argument problem is safe to explain
 * to the model". Any other throw is a framework bug and becomes an infrastructure failure.
 *
 * ## What an AgentTool may not contain
 *
 * ```text
 * riskLevel                requiredCapabilities   runtimeRequirements
 * securityFactsProjector   effectProjector        presentation
 * promptSnippet            RuntimeResolver        Storage
 * Approval repository
 * ```
 *
 * Those belong to the Coding overlay or to the host. A general Tool that grows them has stopped being
 * general, and the model-facing spec would start leaking runtime metadata into a provider request.
 */
export interface AgentTool<
  TArgs extends JsonObject = JsonObject,
  TDetails extends JsonObject = JsonObject,
> extends AIToolSpec {
  /** A UI-independent human label. Never sent to a provider. */
  readonly label: string;
  /** Validates `AgentToolResult.details`. Never sent to a provider. */
  readonly resultDetailsSchema: JsonObject;
  /**
   * Declared execution mode. Frozen to `SEQUENTIAL` behaviour in the first migration wave; the value
   * records intent for a later round rather than changing today's scheduling.
   */
  readonly executionMode: ToolExecutionMode;
  /** Optional pure compatibility normalization applied before schema validation. */
  readonly prepareArguments?: ((rawArgs: Readonly<JsonObject>) => TArgs) | undefined;
  readonly execute: (input: AgentToolExecutionInput<TArgs>) => Promise<AgentToolResult<TDetails>>;
}
