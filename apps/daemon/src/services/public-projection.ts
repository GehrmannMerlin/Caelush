import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  type AgentRun,
  type AgentSession,
  type ClientAgentRun,
  type ClientAgentSession,
} from "@caelush/protocol";
import { toClientModelSelection } from "../providers/model-canonicalizer.js";

export function toClientAgentRun(run: AgentRun): ClientAgentRun {
  return ClientAgentRunSchema.parse({ ...run, model: toClientModelSelection(run.model) });
}

export function toClientAgentSession(session: AgentSession): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    ...session,
    ...(session.defaultModel === undefined
      ? {}
      : { defaultModel: toClientModelSelection(session.defaultModel) }),
  });
}
