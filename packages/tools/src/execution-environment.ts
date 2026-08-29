import {
  RuntimeRefSchema,
  WorkspaceRefSchema,
  type RuntimeRef,
  type WorkspaceRef,
} from "@caelush/protocol";
import { ToolDispatcherInputError } from "./dispatcher-errors.js";

export interface ToolExecutionEnvironment {
  readonly workspace: WorkspaceRef;
  readonly runtime: RuntimeRef;
}

export function assertToolExecutionEnvironment(
  value: unknown,
): asserts value is ToolExecutionEnvironment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolDispatcherInputError("Tool execution environment is invalid.");
  }
  const environment = value as Record<string, unknown>;
  if (
    Object.keys(environment).length !== 2 ||
    !Object.hasOwn(environment, "workspace") ||
    !Object.hasOwn(environment, "runtime") ||
    !WorkspaceRefSchema.safeParse(environment.workspace).success ||
    !RuntimeRefSchema.safeParse(environment.runtime).success
  ) {
    throw new ToolDispatcherInputError("Tool execution environment is invalid.");
  }
}
