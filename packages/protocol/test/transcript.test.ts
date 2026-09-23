import {
  SessionTranscriptQuerySchema,
  SessionTranscriptResponseSchema,
  TranscriptEntrySchema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const envelope = {
  id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001",
  runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
  conversationTurnId: "turn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
  createdAt: 1_700_000_000_000,
} as const;

describe("Phase 5E transcript protocol", () => {
  it("parses every public transcript entry variant and rejects unknown fields", () => {
    const entries = [
      { ...envelope, kind: "USER", text: "hello", attachments: [{ artifactId: "art_1" }] },
      { ...envelope, id: `${envelope.id}-assistant`, kind: "ASSISTANT", text: "hi" },
      {
        ...envelope,
        id: `${envelope.id}-tool`,
        kind: "TOOL_RESULT",
        toolCallId: "call_1",
        toolName: "read_file",
        text: "contents",
        isError: false,
      },
      {
        ...envelope,
        id: `${envelope.id}-custom`,
        kind: "CUSTOM",
        presentationType: "COMMAND_EXECUTION",
        label: "Command",
        text: "completed",
        metadata: { exitCode: 0 },
      },
      {
        ...envelope,
        id: `${envelope.id}-terminal`,
        kind: "RUN_TERMINAL",
        status: "COMPLETED",
        text: "Run completed",
      },
    ];

    for (const entry of entries) {
      expect(TranscriptEntrySchema.parse(entry)).toEqual(entry);
    }

    expect(
      TranscriptEntrySchema.safeParse({ ...entries[0], providerState: { secret: true } }).success,
    ).toBe(false);
  });

  it("applies bounded pagination defaults and validates response envelopes", () => {
    expect(SessionTranscriptQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(SessionTranscriptQuerySchema.parse({ limit: 10, cursor: "cursor_1" })).toEqual({
      limit: 10,
      cursor: "cursor_1",
    });

    const response = SessionTranscriptResponseSchema.parse({
      items: [{ ...envelope, kind: "ASSISTANT", text: "hello" }],
      nextCursor: "cursor_2",
    });
    expect(response.nextCursor).toBe("cursor_2");
  });
});
