/**
 * Who may see one message.
 *
 * ```text
 * model        may the model be shown it?
 * transcript   is it part of the user-visible conversation transcript?
 * debug        is it retained as diagnostic material?
 * ```
 *
 * The three are independent, and keeping them independent is what stops two mistakes
 * that a single "visible" flag makes inevitable:
 *
 * ```text
 * a Tool result is model-visible and deliberately NOT transcript-visible
 * a hidden custom message may be transcript-visible and NOT model-visible
 * ```
 *
 * The `model` flag is the one with consequences beyond presentation. It decides whether
 * a message consumes model context budget, whether it must be projected for replay at
 * all, and whether a Tool call it announces is part of the model-visible Tool protocol.
 * Phase 5A's validator and selector both read it, and neither may treat it as a
 * display hint.
 */
export interface AgentMessageAudience {
  readonly model: boolean;

  readonly transcript: boolean;

  readonly debug: boolean;
}

/** Every audience field, in canonical order. */
export const AGENT_MESSAGE_AUDIENCE_FIELDS = ["model", "transcript", "debug"] as const;

/**
 * The audience defaults, one place per message kind.
 *
 * ```text
 * USER         model true   transcript true    debug true
 * ASSISTANT    model true   transcript true    debug true
 * TOOL_RESULT  model true   transcript false   debug true
 * ```
 *
 * `TOOL_RESULT` is not transcript-visible because a transcript is the account a *user*
 * reads: a Tool result is the model's own feedback channel, and rendering it as
 * conversation would show the user a payload they were never meant to read, including
 * file contents and command output.
 *
 * These constants exist so the defaults are stated once. A Message Factory that
 * restated them, or a caller that assembled an audience by hand, would be a second
 * authority over who sees what.
 */
export const AGENT_USER_MESSAGE_AUDIENCE: AgentMessageAudience = Object.freeze({
  model: true,
  transcript: true,
  debug: true,
});

export const AGENT_ASSISTANT_MESSAGE_AUDIENCE: AgentMessageAudience = Object.freeze({
  model: true,
  transcript: true,
  debug: true,
});

export const AGENT_TOOL_RESULT_MESSAGE_AUDIENCE: AgentMessageAudience = Object.freeze({
  model: true,
  transcript: false,
  debug: true,
});

/** Assert a well-formed audience. */
export function assertAgentMessageAudience(value: unknown): asserts value is AgentMessageAudience {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent message audience must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of AGENT_MESSAGE_AUDIENCE_FIELDS) {
    if (typeof candidate[field] !== "boolean") {
      throw new TypeError(`Agent message audience ${field} must be a boolean.`);
    }
  }
}
