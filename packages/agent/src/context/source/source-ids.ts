import { createContextSourceId, type ContextSourceId } from "../item/context-item.js";

export const AGENT_CONTEXT_SOURCE_IDS = Object.freeze({
  conversation: createContextSourceId("agent.conversation"),
  checkpoint: createContextSourceId("agent.checkpoint"),
  memory: createContextSourceId("agent.memory"),
  extensionContributions: createContextSourceId("agent.extension-contributions"),
  branchContext: createContextSourceId("agent.branch-context"),
} satisfies Readonly<{
  readonly conversation: ContextSourceId;
  readonly checkpoint: ContextSourceId;
  readonly memory: ContextSourceId;
  readonly extensionContributions: ContextSourceId;
  readonly branchContext: ContextSourceId;
}>);
