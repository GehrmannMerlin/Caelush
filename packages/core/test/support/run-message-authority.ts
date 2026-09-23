import {
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
} from "@caelush/agent";
import { createTimestampMs } from "@caelush/protocol";

import type { RunMessageAuthority } from "../../src/run-message-materializer.js";

/** The canonical V2 message authority used by Core and Storage tests. */
export function testRunMessageAuthority(): RunMessageAuthority {
  const projectors = createStandardAgentMessageProjectorRegistry();
  const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));
  const turns = createDeterministicConversationTurnIdFactory();
  return {
    codecs,
    projectors,
    turns,
    factory: createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => createTimestampMs(1),
      turns,
    }),
    userOrigin: async () => "GOAL",
  };
}
