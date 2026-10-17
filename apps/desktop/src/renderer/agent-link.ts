import { SessionIdSchema, type SessionId } from "@caelush/protocol";

export function createAgentDeepLink(
  input: {
    readonly sessionId?: SessionId;
    readonly settings?: "models";
  } = {},
): string {
  const query = new URLSearchParams();
  if (input.sessionId !== undefined) query.set("session", SessionIdSchema.parse(input.sessionId));
  if (input.settings !== undefined) query.set("settings", input.settings);
  const search = query.toString();
  return `caelush-app://app/agent/${search === "" ? "" : `?${search}`}`;
}
