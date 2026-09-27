import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";
import type { ToolName } from "@caelush/protocol";

import {
  MAX_TOOL_PROMPT_TOTAL_BYTES,
  promptSnippetFor,
} from "../../tools/prompt/prompt-snippets.js";
import {
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "tool-guidance-v1";

export interface ToolGuidanceContextSourceProviderOptions extends CodingContextProviderOptions {
  /** The immutable registration-order projection of the canonical active Agent Tool registry. */
  readonly activeToolNames: readonly ToolName[];
}

/**
 * Project active Coding Tool usage guidance into one native Context V2 item.
 *
 * The provider deliberately accepts only Tool names. The daemon supplies those names from the same
 * `AgentToolRegistry` that produces the model-visible Tool specs, so this source cannot create a
 * second Tool authority or reach Tool handlers, Runtime, Security or live workspace state.
 *
 * `REHYDRATABLE` is intentional: the text is deterministic compiled Coding data, so recovery and
 * compaction can regenerate it from the active Tool-name projection instead of persisting it as a
 * conversation record or checkpoint authority. The retention also keeps active guidance mandatory
 * in the normal Context plan rather than allowing migration to silently drop it.
 */
export function createToolGuidanceContextSourceProvider(
  options: ToolGuidanceContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  const activeToolNames = Object.freeze([...options.activeToolNames]);

  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.toolGuidance,
    async collect(input: ContextSourceInput) {
      const blocks: string[] = [];
      let bytes = 0;
      for (const toolName of activeToolNames) {
        const snippet = promptSnippetFor(toolName);
        if (snippet === undefined) continue;
        const snippetBytes = Buffer.byteLength(snippet, "utf8");
        if (bytes + snippetBytes > MAX_TOOL_PROMPT_TOTAL_BYTES) break;
        blocks.push(snippet);
        bytes += snippetBytes;
      }
      if (blocks.length === 0) {
        return createCodingSourceResult(
          CODING_CONTEXT_SOURCE_IDS.toolGuidance,
          PROVIDER_VERSION,
          [],
        );
      }

      const text = [
        "<tool_guidance>",
        "Tool usage guidance. Follow it when choosing and calling tools.",
        "",
        blocks.join("\n\n"),
        "</tool_guidance>",
      ].join("\n");
      const item = createCodingTextItem({
        id: "coding.tool-guidance:active",
        providerId: CODING_CONTEXT_SOURCE_IDS.toolGuidance,
        sourceRef: "coding-tools:active",
        version: PROVIDER_VERSION,
        type: "coding.tool_guidance",
        scope: "RUN",
        retention: "REHYDRATABLE",
        priorityClass: "NORMAL",
        cacheStability: "STABLE",
        freshness: "CURRENT",
        sensitivity: "PUBLIC",
        whyLoaded: "active Coding Tool usage guidance",
        text,
        input,
        tokenEstimator,
      });
      return createCodingSourceResult(CODING_CONTEXT_SOURCE_IDS.toolGuidance, PROVIDER_VERSION, [
        item,
      ]);
    },
  });
}
