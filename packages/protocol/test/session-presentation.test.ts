import {
  SessionTurnPresentationQuerySchema,
  SessionTurnPresentationResponseSchema,
  TurnPresentationItemSchema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const base = {
  id: "presentation_1",
  runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
  conversationTurnId: "turn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
  ordinal: 1,
  status: "COMPLETED" as const,
  createdAt: 1_700_000_000_000,
};

describe("session turn presentation protocol", () => {
  it("parses every item kind while keeping the wire shape safe and strict", () => {
    const items = [
      { ...base, kind: "USER", text: "inspect the project" },
      {
        ...base,
        id: "presentation_2",
        ordinal: 2,
        kind: "ASSISTANT",
        phase: "COMMENTARY",
        text: "I will inspect the files first.",
      },
      {
        ...base,
        id: "presentation_3",
        ordinal: 3,
        kind: "TOOL",
        toolInvocationId: "tinv_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
        toolName: "read_file",
        title: "读取文件",
        summary: "读取 src/index.ts",
        facts: [{ key: "路径", value: "src/index.ts" }],
        preview: "safe preview",
      },
      {
        ...base,
        id: "presentation_4",
        ordinal: 4,
        kind: "VERIFICATION",
        verificationId: "vfy_1",
        title: "验证测试",
        summary: "已运行目标测试",
      },
      {
        ...base,
        id: "presentation_5",
        ordinal: 5,
        kind: "RUN_SUMMARY",
        runStatus: "COMPLETED",
        text: "任务已完成",
      },
    ];

    for (const item of items) expect(TurnPresentationItemSchema.parse(item)).toEqual(item);

    expect(
      TurnPresentationItemSchema.safeParse({ ...items[2], args: { password: "secret" } }).success,
    ).toBe(false);
  });

  it("bounds pagination and rejects an illegal presentation status", () => {
    expect(SessionTurnPresentationQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(
      SessionTurnPresentationQuerySchema.parse({ runId: base.runId, limit: 20, cursor: "seq_4" }),
    ).toEqual({ runId: base.runId, limit: 20, cursor: "seq_4" });
    expect(
      TurnPresentationItemSchema.safeParse({ ...base, kind: "USER", text: "x", status: "UNKNOWN" })
        .success,
    ).toBe(false);
  });

  it("parses a response with a durable high watermark", () => {
    const response = SessionTurnPresentationResponseSchema.parse({
      items: [{ ...base, kind: "USER", text: "hello" }],
      highWatermark: 12,
      nextCursor: "seq_12",
    });
    expect(response.highWatermark).toBe(12);
  });
});
