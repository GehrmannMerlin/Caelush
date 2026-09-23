import {
  createAgentMessageCodecRegistry,
  createAgentMessageProjectorRegistry,
  createAgentMessageTranscriptProjectorRegistry,
  STANDARD_AGENT_MESSAGE_CODECS,
  STANDARD_AGENT_MESSAGE_PROJECTORS,
  STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";

import {
  CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1,
  CODING_COMMAND_EXECUTION_MESSAGE_PROJECTOR_V1,
  CODING_COMMAND_EXECUTION_TRANSCRIPT_PROJECTOR,
  type CodingCommandExecutionMessage,
} from "@caelush/coding-agent";

const message: CodingCommandExecutionMessage = {
  id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000099" as never,
  runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" as never,
  sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never,
  conversationTurnId: "cturn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c" as never,
  createdAt: 1_700_000_000_000 as never,
  source: { kind: "AGENT", producer: "coding.command" },
  audience: { model: true, transcript: true, debug: true },
  type: "CODING_COMMAND_EXECUTION",
  command: "pnpm test --filter secret-token",
  output: "command output",
  exitCode: 0,
  cancelled: false,
  truncated: false,
  fullOutputArtifactId: "art_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9d",
};

describe("Phase 5E Coding custom AgentMessage", () => {
  it("composes codec, AI projector and transcript projector without a core union edit", () => {
    const projectors = createAgentMessageProjectorRegistry({
      projectors: [
        ...STANDARD_AGENT_MESSAGE_PROJECTORS,
        CODING_COMMAND_EXECUTION_MESSAGE_PROJECTOR_V1,
      ],
    });
    const codecs = createAgentMessageCodecRegistry({
      codecs: [...STANDARD_AGENT_MESSAGE_CODECS, CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1],
      projectionVersionOf: (type) => projectors.currentVersion(type),
    });
    const transcriptProjectors = createAgentMessageTranscriptProjectorRegistry({
      projectors: [
        ...STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS,
        CODING_COMMAND_EXECUTION_TRANSCRIPT_PROJECTOR,
      ],
    });

    const draft = codecs.encode(message);
    expect(draft.data).toMatchObject({
      command: message.command,
      output: message.output,
      cancelled: false,
      truncated: false,
    });

    const aiProjection = projectors.project({
      sequence: 1,
      schemaVersion: 1,
      modelProjectionVersion: 1,
      message,
    });
    expect(aiProjection.messages[0]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(aiProjection.messages[0])).not.toContain(message.fullOutputArtifactId);

    const transcript = transcriptProjectors.project({
      sequence: 1,
      schemaVersion: 1,
      modelProjectionVersion: 1,
      message,
    });
    expect(transcript[0]).toMatchObject({
      kind: "CUSTOM",
      presentationType: "COMMAND_EXECUTION",
      label: message.command,
      text: message.output,
    });
    expect(JSON.stringify(transcript[0])).not.toContain(message.fullOutputArtifactId);
  });
});
