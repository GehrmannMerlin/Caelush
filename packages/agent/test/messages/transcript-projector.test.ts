import {
  createAgentMessageTranscriptProjectorRegistry,
  createStandardAgentMessageTranscriptProjectorRegistry,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";

import { assistantMessage, toolResultMessage, userMessage } from "./fixtures.js";

describe("Phase 5E transcript projectors", () => {
  it("projects user and assistant messages into the public transcript shape", () => {
    const registry = createStandardAgentMessageTranscriptProjectorRegistry();
    const user = userMessage({ withAttachment: true });
    const assistant = assistantMessage({ text: "answer" });

    expect(registry.project(user)).toEqual([
      {
        id: `${user.message.id}:transcript`,
        runId: user.message.runId,
        conversationTurnId: user.message.conversationTurnId,
        createdAt: user.message.createdAt,
        kind: "USER",
        text: "hello",
        attachments: [{ artifactId: "art_1", label: "diagram", mediaType: "image/png" }],
      },
    ]);

    expect(registry.project(assistant)).toEqual([
      {
        id: `${assistant.message.id}:transcript`,
        runId: assistant.message.runId,
        conversationTurnId: assistant.message.conversationTurnId,
        createdAt: assistant.message.createdAt,
        kind: "ASSISTANT",
        text: "answer",
      },
    ]);
  });

  it("honors transcript audience independently from model visibility", () => {
    const registry = createStandardAgentMessageTranscriptProjectorRegistry();
    const tool = toolResultMessage({ projectedContent: "secret tool output" });

    expect(registry.project(tool)).toEqual([]);
    expect(registry.project(userMessage({ modelVisible: false }))).toHaveLength(1);
  });

  it("lets product layers compose custom transcript projectors without changing the kernel union", () => {
    const registry = createAgentMessageTranscriptProjectorRegistry({
      projectors: [
        {
          type: "CODING_COMMAND_EXECUTION",
          project(stored) {
            const message = stored.message as typeof stored.message & {
              readonly command: string;
              readonly output: string;
              readonly exitCode?: number;
              readonly cancelled: boolean;
              readonly truncated: boolean;
            };
            return [
              {
                id: `${message.id}:transcript`,
                runId: message.runId,
                conversationTurnId: message.conversationTurnId,
                createdAt: message.createdAt,
                kind: "CUSTOM",
                presentationType: "COMMAND_EXECUTION",
                label: message.command,
                text: message.output,
                metadata: {
                  ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
                  cancelled: message.cancelled,
                  truncated: message.truncated,
                },
              },
            ];
          },
        },
      ],
    });

    const stored = userMessage();
    const custom = {
      ...stored,
      message: {
        ...stored.message,
        id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000009",
        type: "CODING_COMMAND_EXECUTION",
        command: "pnpm test",
        output: "ok",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    } as never;

    expect(registry.project(custom)).toMatchObject([
      {
        kind: "CUSTOM",
        presentationType: "COMMAND_EXECUTION",
        label: "pnpm test",
        text: "ok",
      },
    ]);
  });
});
