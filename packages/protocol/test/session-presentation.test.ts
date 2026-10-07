import {
  AssistantPresentationItemV2Schema,
  SessionTurnPresentationQuerySchema,
  SessionTurnPresentationResponseSchema,
  SessionTurnPresentationResponseV1Schema,
  SessionTurnPresentationResponseV2Schema,
  SessionTurnPresentationResponseV3Schema,
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
    expect(response.capabilityVersion).toBe(1);
  });

  it("keeps v1 assistant items strict and accepts unversioned responses as v1", () => {
    const assistant = { ...base, kind: "ASSISTANT", phase: "FINAL_ANSWER", text: "done" };
    expect(AssistantPresentationItemV2Schema.safeParse(assistant).success).toBe(true);
    expect(
      AssistantPresentationItemV2Schema.safeParse({
        ...assistant,
        sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      }).success,
    ).toBe(true);
    expect(
      SessionTurnPresentationResponseSchema.parse({ items: [assistant], highWatermark: 1 })
        .capabilityVersion,
    ).toBe(1);
    expect(
      SessionTurnPresentationResponseV1Schema.safeParse({
        capabilityVersion: 1,
        items: [{ ...assistant, sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" }],
        highWatermark: 1,
      }).success,
    ).toBe(false);
  });

  it("validates v2 assistant source steps and rejects unknown fields", () => {
    const assistant = { ...base, kind: "ASSISTANT", phase: "FINAL_ANSWER", text: "done" };
    expect(AssistantPresentationItemV2Schema.parse(assistant)).toEqual(assistant);
    expect(
      AssistantPresentationItemV2Schema.parse({
        ...assistant,
        sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      }).sourceStepId,
    ).toBe("stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a");
    expect(
      AssistantPresentationItemV2Schema.safeParse({ ...assistant, sourceStepId: "bad" }).success,
    ).toBe(false);
    expect(AssistantPresentationItemV2Schema.safeParse({ ...assistant, extra: true }).success).toBe(
      false,
    );
    expect(
      SessionTurnPresentationResponseV2Schema.parse({
        capabilityVersion: 2,
        items: [assistant],
        highWatermark: 1,
      }).capabilityVersion,
    ).toBe(2);
    expect(
      SessionTurnPresentationResponseV1Schema.safeParse({
        capabilityVersion: 2,
        items: [],
        highWatermark: 1,
      }).success,
    ).toBe(false);
  });

  it("parses turn-first v3 pages and validates each Turn's item scope", () => {
    const turn = {
      runId: base.runId,
      conversationTurnId: base.conversationTurnId,
      runStatus: "RUNNING",
      openedAt: 1_700_000_000_000,
      highWatermark: 7,
      items: [{ ...base, ordinal: 0, kind: "USER", text: "hello" }],
    };
    const response = SessionTurnPresentationResponseSchema.parse({
      capabilityVersion: 3,
      turns: [turn],
    });

    expect(response).toMatchObject({ capabilityVersion: 3, turns: [turn] });
    expect(
      SessionTurnPresentationResponseV3Schema.safeParse({
        capabilityVersion: 3,
        turns: [
          {
            ...turn,
            items: [{ ...turn.items[0], runId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SessionTurnPresentationResponseV3Schema.safeParse({
        capabilityVersion: 3,
        turns: [{ ...turn, items: [{ ...turn.items[0], conversationTurnId: "another-turn" }] }],
      }).success,
    ).toBe(false);
    expect(
      SessionTurnPresentationResponseV3Schema.safeParse({
        capabilityVersion: 3,
        turns: [{ ...turn, items: [{ ...turn.items[0], ordinal: 2 }] }],
      }).success,
    ).toBe(false);
  });

  it("parses structured Tool Activity lifecycle and file effects in V3", () => {
    const tool = {
      ...base,
      ordinal: 0,
      kind: "TOOL",
      toolInvocationId: "tinv_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      toolName: "apply_patch",
      category: "EDIT",
      phase: "COMPLETED",
      title: "编辑文件",
      summary: "补丁已应用",
      facts: [],
      effects: [
        {
          type: "FILE_CHANGE",
          path: "login.html",
          changeType: "CREATED",
          additions: 214,
          deletions: 0,
        },
      ],
    };
    const response = {
      capabilityVersion: 3,
      turns: [
        {
          runId: base.runId,
          conversationTurnId: base.conversationTurnId,
          runStatus: "COMPLETED",
          openedAt: base.createdAt,
          highWatermark: 8,
          items: [tool],
        },
      ],
    };

    expect(SessionTurnPresentationResponseV3Schema.parse(response)).toEqual(response);
    expect(
      SessionTurnPresentationResponseV3Schema.safeParse({
        ...response,
        turns: [
          {
            ...response.turns[0],
            items: [{ ...tool, effects: [{ ...tool.effects[0], path: "C:/private/.env" }] }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("continues to parse legacy v1 and v2 response contracts", () => {
    expect(
      SessionTurnPresentationResponseSchema.parse({
        capabilityVersion: 1,
        items: [],
        highWatermark: 3,
      }).capabilityVersion,
    ).toBe(1);
    expect(
      SessionTurnPresentationResponseSchema.parse({
        capabilityVersion: 2,
        items: [],
        highWatermark: 5,
      }).capabilityVersion,
    ).toBe(2);
  });
});
