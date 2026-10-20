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
 * stated once rather than ten times:
 *
 * ```text
 * executionMode defaults to SEQUENTIAL   a Tool opts into a parallel window explicitly
 * label is derived from the name        stable and human-readable, never model-facing
 * the tool is frozen                    a builtin is data plus a function, not a mutable object
 * ```
 *
 * ## Who may declare `PARALLEL_SAFE`
 *
 * Only a Tool that **reads and never mutates** the workspace: it must be safe for a sibling read to
 * observe the same state, and it must not need an approval that could park the batch mid-window. The
 * coordinator still refuses to form a window under `ALWAYS_ASK`, and the host still has to turn
 * parallelism on. Declaring the mode is a statement about the Tool, not a scheduling decision.
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
  /** Declared scheduling capability; omitted means `SEQUENTIAL`. */
  readonly executionMode?: AgentTool["executionMode"];
}

/**
 * Build the canonical executable Tool for one Coding builtin.
 *
 * The result is frozen, sequential and schema-complete, so every consumer — the registry, the Preparer,
 * the executor — sees exactly the same contract shape for all ten Tools.
 */
export function defineCodingTool(input: CodingToolDefinitionInput): AgentTool {
  return Object.freeze({
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    label: humanizeToolName(input.name),
    resultDetailsSchema: input.resultDetailsSchema,
    executionMode: input.executionMode ?? "SEQUENTIAL",
    ...(input.prepareArguments === undefined ? {} : { prepareArguments: input.prepareArguments }),
    execute: input.execute,
  });
}
