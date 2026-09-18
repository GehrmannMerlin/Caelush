import type { ToolName } from "@caelush/protocol";

import { DEFAULT_MAX_INVOCATION_ARGS_BYTES } from "./dispatcher-types.js";
import {
  ToolValidationError,
  validateToolArguments,
  type NormalizedArguments,
} from "./legacy-argument-validation.js";
import type { ResolvedTool, ToolRegistry } from "./registry.js";

export type ToolPreflightResult =
  | { readonly kind: "UNAVAILABLE_TOOL"; readonly toolName: ToolName }
  | {
      readonly kind: "INVALID_ARGUMENTS";
      readonly toolName: ToolName;
      readonly error: ToolValidationError;
    }
  | {
      readonly kind: "READY";
      readonly toolName: ToolName;
      readonly tool: ResolvedTool;
      readonly args: NormalizedArguments;
    };

export interface ToolPreflightOptions {
  readonly maxInvocationArgsBytes?: number;
}

/**
 * The legacy preflight facade: resolution, compatibility normalization, input-contract boundary.
 *
 * ```text
 * ToolPreflight.prepare(toolName, args)
 *   ├── registry.resolve(name)                     canonical resolution
 *   └── validateToolArguments(tool, args, bound)   canonical normalization + canonical validator
 * ```
 *
 * It executes nothing, and it owns no algorithm: resolution is the canonical registry's, and
 * normalization and validation are the canonical schema runtime's through
 * `legacy-argument-validation.ts`.
 *
 * ## One recorded compatibility facet, not a second authority
 *
 * This facade bounds arguments **after** normalization, because that is the observable behaviour its
 * callers already depend on. The canonical `ToolCallPreparer` additionally bounds the *raw* payload,
 * which is a tightening the Tool-call boundary needs and this legacy question does not.
 *
 * It is recorded here rather than unified because changing it would change what an existing caller
 * observes, and because a legacy `prepare(toolName, unknown)` question about "would these arguments
 * be accepted" is not the same operation as "prepare this model call": it creates no call, holds no
 * identity, and is not on the durable path.
 */
export class ToolPreflight {
  private readonly maxInvocationArgsBytes: number;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolPreflightOptions = {},
  ) {
    this.maxInvocationArgsBytes =
      options.maxInvocationArgsBytes ?? DEFAULT_MAX_INVOCATION_ARGS_BYTES;
  }

  prepare(toolName: ToolName, args: unknown): ToolPreflightResult {
    const tool = this.registry.resolve(toolName);
    if (tool === undefined) return { kind: "UNAVAILABLE_TOOL", toolName };
    try {
      return {
        kind: "READY",
        toolName,
        tool,
        args: validateToolArguments(tool, args, { maxBytes: this.maxInvocationArgsBytes }),
      };
    } catch (error) {
      if (error instanceof ToolValidationError) {
        return { kind: "INVALID_ARGUMENTS", toolName, error };
      }
      throw error;
    }
  }
}
