import type { LegacyContextItem } from "@caelush/agent";
import type { ToolName } from "@caelush/protocol";

import { MAX_TOOL_PROMPT_TOTAL_BYTES, promptSnippetFor } from "./prompt-snippets.js";

/**
 * The Coding Tool prompt context provider.
 *
 * ```text
 * active tool names  →  their promptSnippets  →  deterministic ContextItem[]  →  ContextEngine
 * ```
 *
 * ## Why a provider, and not a description suffix
 *
 * Usage guidance used to be concatenated onto each Tool's `description`, which put it inside the
 * *provider tool definition*. That meant it was counted against the tool-catalog budget, it was sent
 * whether or not the Tool was exposed for the Run, and it could not be treated as context because it
 * was not context.
 *
 * A provider contributes the guidance to the Context Engine instead, so the text is budgeted with the
 * rest of the model input, selected against the tools that are actually active, and delivered exactly
 * once. The Tool's own `description` stays a short, stable statement of what the Tool is.
 *
 * ## What this provider may not do
 *
 * It is a pure projection over Tool metadata:
 *
 * ```text
 * no Runtime read          no Tool execution        no Storage read
 * no security decision     no registry mutation    no model call
 * ```
 *
 * Its only input is the active tool name list, which is what makes it deterministic and testable.
 *
 * ## Active-set filtering and order
 *
 * `provide` selects snippets for exactly the names it is given, in the order it is given them. That
 * order is the registry's registration order, so the guidance block cannot drift from the tool catalog
 * through a sort, a `Map` iteration or an object-key accident. A Tool that is not active contributes no
 * snippet — a Git Tool a host did not expose must not describe itself to the model.
 *
 * A generic `AgentTool` a host registered has no Coding snippet and is skipped rather than given a
 * placeholder.
 */
export interface ToolPromptContextProviderInput {
  /**
   * The active Tool names, in registry order.
   *
   * The caller is the layer that knows which Tools this Run actually exposes — after environment
   * filtering — so the provider cannot accidentally describe a Tool that is not there.
   */
  readonly activeTools: readonly ToolName[];
}

export interface ToolPromptContextProvider {
  provide(input: ToolPromptContextProviderInput): Promise<readonly LegacyContextItem[]>;
}

export interface ToolPromptContextItem extends LegacyContextItem {
  readonly type: "TOOL_GUIDANCE";
}

/** The stable id of the single item this provider contributes. */
export const TOOL_PROMPT_CONTEXT_ITEM_ID = "coding.tool_guidance.v1";

/**
 * Build the provider.
 *
 * One compatibility ContextItem carrying every active Tool's guidance, rather than one item per Tool: the block is
 * read as a unit, and splitting it would let a budget algorithm drop half of a Tool's guidance while
 * keeping the other half.
 *
 * The total is bounded by `MAX_TOOL_PROMPT_TOTAL_BYTES`. A block that would exceed the bound drops whole
 * Tools from the tail rather than truncating a snippet mid-sentence, because half a safety note is worse
 * than no safety note: a reader cannot tell what was cut.
 */
export function createToolPromptContextProvider(): ToolPromptContextProvider {
  return {
    async provide(input): Promise<readonly LegacyContextItem[]> {
      const blocks: string[] = [];
      let bytes = 0;
      for (const toolName of input.activeTools) {
        const snippet = promptSnippetFor(toolName);
        if (snippet === undefined) continue;
        const snippetBytes = Buffer.byteLength(snippet, "utf8");
        if (bytes + snippetBytes > MAX_TOOL_PROMPT_TOTAL_BYTES) break;
        blocks.push(snippet);
        bytes += snippetBytes;
      }
      if (blocks.length === 0) return Object.freeze([]);

      const content = [
        "Tool usage guidance. Follow it when choosing and calling tools.",
        "",
        blocks.join("\n\n"),
      ].join("\n");

      return Object.freeze([
        Object.freeze({
          id: TOOL_PROMPT_CONTEXT_ITEM_ID,
          priorityClass: "NORMAL" as const,
          content,
          tokenEstimate: Math.ceil(Buffer.byteLength(content, "utf8") / 3),
          whyLoaded: `Tool guidance for ${blocks.length} active tool(s).`,
        }),
      ]);
    },
  };
}
