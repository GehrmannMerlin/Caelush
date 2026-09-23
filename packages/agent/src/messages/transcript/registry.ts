import type { TranscriptEntry } from "@caelush/protocol";

import type { StoredAgentMessage } from "../persistence/record.js";
import type { AgentMessage } from "../types/agent-message.js";
import {
  STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS,
  unsupportedHistoricalTranscriptEntry,
} from "./projector.js";
import type { AgentMessageTranscriptProjector } from "./projector.js";

export interface AgentMessageTranscriptProjectorRegistry {
  has(type: string): boolean;
  get(type: string): AgentMessageTranscriptProjector | undefined;
  project(stored: StoredAgentMessage): readonly TranscriptEntry[];
}

export function createAgentMessageTranscriptProjectorRegistry(options: {
  readonly projectors: readonly AgentMessageTranscriptProjector[];
}): AgentMessageTranscriptProjectorRegistry {
  const byType = new Map<string, AgentMessageTranscriptProjector>();
  for (const projector of options.projectors) {
    if (byType.has(projector.type)) {
      throw new RangeError(
        `An agent message transcript projector is already registered for type ${JSON.stringify(projector.type)}.`,
      );
    }
    byType.set(projector.type, projector);
  }

  return {
    has(type: string): boolean {
      return byType.has(type);
    },
    get(type: string): AgentMessageTranscriptProjector | undefined {
      return byType.get(type);
    },
    project(stored: StoredAgentMessage): readonly TranscriptEntry[] {
      const message = stored.message as AgentMessage;
      if (!message.audience.transcript) return [];
      const projector = byType.get(message.type);
      return projector === undefined
        ? [unsupportedHistoricalTranscriptEntry(message)]
        : projector.project(stored);
    },
  };
}

export function createStandardAgentMessageTranscriptProjectorRegistry(): AgentMessageTranscriptProjectorRegistry {
  return createAgentMessageTranscriptProjectorRegistry({
    projectors: [...STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS],
  });
}
