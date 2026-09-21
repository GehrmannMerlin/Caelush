import type { AgentTool } from "@caelush/agent";

/**
 * The shared Coding builtin helper.
 *
 * ```text
 * defineCodingTool({ name, description, inputSchema, resultDetailsSchema, execute })
 *   → a frozen AgentTool whose identity, schema and execution mode are decided once
 * ```
 *
 * Every Coding builtin is an `AgentTool` with the same five invariants, and this is where they are
 * stated once rather than nine times:
 *
 * ```text
 * executionMode is SEQUENTIAL   the first migration wave schedules every batch sequentially; a Tool
 *                               that would be parallel-safe later does not get to opt in now
 * label is derived from the name   stable and human-readable, never model-facing
 * the tool is frozen            a builtin is data plus a function, not a mutable object
 * ```
 *
 * ## Why `label` and not a display string
 *
 * `label` is the Tool Layer's own short human name (`Read File`). It is not a product string and it is
 * not sent to a model: the model sees `name`, `description` and `inputSchema` only. Presentation is the
 * presentation layer's business, and it receives the Tool, not a pre-rendered title.
 */

/** A stable, human-readable label derived from a tool name. */
export function humanizeToolName(name: string): string {
  const words = name.split("_").filter((part) => part.length > 0);
  if (words.length === 0) return name;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export interface CodingToolDefinitionInput {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AgentTool["inputSchema"];
  readonly resultDetailsSchema: AgentTool["resultDetailsSchema"];
  readonly execute: AgentTool["execute"];
  readonly prepareArguments?: AgentTool["prepareArguments"];
}

/**
 * Build the canonical executable Tool for one Coding builtin.
 *
 * The result is frozen, sequential and schema-complete, so every consumer — the registry, the Preparer,
 * the executor — sees exactly the same contract shape for all nine Tools.
 */
export function defineCodingTool(input: CodingToolDefinitionInput): AgentTool {
  return Object.freeze({
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    label: humanizeToolName(input.name),
    resultDetailsSchema: input.resultDetailsSchema,
    executionMode: "SEQUENTIAL",
    ...(input.prepareArguments === undefined ? {} : { prepareArguments: input.prepareArguments }),
    execute: input.execute,
  });
}
