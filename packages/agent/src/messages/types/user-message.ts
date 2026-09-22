import { assertAgentUserContent } from "./content.js";
import type { AgentUserContentPart } from "./content.js";
import type { AgentMessageBase } from "./message-base.js";

/**
 * Something a user said.
 *
 * ```text
 * type     "USER"
 * content  one or more user content parts
 * ```
 *
 * `content` is never empty and never merely empty text: the shared
 * {@link assertAgentUserContent} rule requires at least one part that actually carries
 * something. A user turn with nothing in it is not a turn.
 *
 * The `source` of a user message names *which* kind of user input it was — a goal, a
 * follow-up, a steering note — because the three have different provenance and a later
 * phase may need to distinguish them. It never names `LEGACY`: a message created now was
 * not migrated from anything.
 */
export interface AgentUserMessage extends AgentMessageBase {
  readonly type: "USER";

  readonly content: readonly AgentUserContentPart[];
}

/** Create a frozen user message. */
export function createAgentUserMessage(
  base: AgentMessageBase,
  content: readonly AgentUserContentPart[],
): AgentUserMessage {
  assertAgentUserContent(content);
  return Object.freeze({ ...base, type: "USER" as const, content: Object.freeze([...content]) });
}
