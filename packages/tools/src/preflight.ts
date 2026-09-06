import type { ToolName } from "@caelush/protocol";
import { DEFAULT_MAX_INVOCATION_ARGS_BYTES } from "./dispatcher-types.js";
import {
  ToolValidationError,
  validateToolArguments,
  type NormalizedArguments,
} from "./argument-validation.js";
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

/** Non-executing Tool resolution, normalization, and input-contract boundary. */
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
