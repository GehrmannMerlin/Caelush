import { createAIError } from "@caelush/ai";
import type { AIToolResultContent, AIUserContent } from "@caelush/ai";
import { agentTextPart } from "@caelush/agent";
import type { AgentUserContentPart } from "@caelush/agent";

/** Convert the text-only legacy Tool history contract without dropping image content. */
export function toTextOnlyAIToolResultContent(content: AIToolResultContent): string {
  if (typeof content === "string") return content;
  if (content.some((part) => part.type === "image")) {
    throw createAIError(
      "AI_CAPABILITY_UNSUPPORTED",
      "Image-bearing Tool results require attachment-reference replay before they can be persisted.",
    );
  }
  return content.map((part) => (part as Extract<AIUserContent, { type: "text" }>).text).join("\n");
}

/** Convert provider-neutral user text while rejecting image bytes on legacy compatibility paths. */
export function toTextOnlyAgentUserContent(
  content: string | readonly AIUserContent[],
): readonly AgentUserContentPart[] {
  if (typeof content === "string") return [agentTextPart(content)];
  if (content.some((part) => part.type === "image")) {
    throw createAIError(
      "AI_CAPABILITY_UNSUPPORTED",
      "Image-bearing input cannot be persisted through the legacy conversation compatibility path.",
    );
  }
  return content.map((part) =>
    agentTextPart((part as { readonly type: "text"; readonly text: string }).text),
  );
}
