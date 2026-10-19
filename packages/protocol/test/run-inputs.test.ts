import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPE_CATALOG,
  RUN_INPUT_TEXT_MAX_BYTES,
  DaemonInfoSchema,
  RunInputListQuerySchema,
  RunInputReceiptSchema,
  RunEventSchemaDecodeError,
  RunEventSchemaRegistryInstance,
  SubmitRunInputRequestSchema,
  utf8ByteLength,
} from "../src/index.js";

const ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "run_0195f3a0-0000-7000-8000-000000000001";

describe("Run input contracts", () => {
  it("accepts one strict text submission and refuses every extra field", () => {
    expect(SubmitRunInputRequestSchema.parse({ inputId: ID, text: "  keep the SDK  " })).toEqual({
      inputId: ID,
      text: "  keep the SDK  ",
    });
    for (const extra of [
      { attachmentIds: ["att_1"] },
      { provider: "other" },
      { sessionId: "ses_x" },
      { runId: RUN_ID },
    ]) {
      expect(
        SubmitRunInputRequestSchema.safeParse({ inputId: ID, text: "x", ...extra }).success,
      ).toBe(false);
    }
    expect(
      SubmitRunInputRequestSchema.safeParse({ inputId: "not-a-uuid", text: "x" }).success,
    ).toBe(false);
  });

  it("rejects empty and oversized text without truncating it", () => {
    expect(SubmitRunInputRequestSchema.safeParse({ inputId: ID, text: "   " }).success).toBe(false);
    const exact = "x".repeat(RUN_INPUT_TEXT_MAX_BYTES);
    expect(SubmitRunInputRequestSchema.safeParse({ inputId: ID, text: exact }).success).toBe(true);
    expect(SubmitRunInputRequestSchema.safeParse({ inputId: ID, text: `x${exact}` }).success).toBe(
      false,
    );
    // A multi-byte character counts by its UTF-8 bytes, not by code units.
    const multiByte = "中".repeat(Math.floor(RUN_INPUT_TEXT_MAX_BYTES / 3) + 1);
    expect(utf8ByteLength(multiByte)).toBeGreaterThan(RUN_INPUT_TEXT_MAX_BYTES);
    expect(SubmitRunInputRequestSchema.safeParse({ inputId: ID, text: multiByte }).success).toBe(
      false,
    );
  });

  it("projects a bounded receipt whose stage cannot claim more than it proves", () => {
    expect(
      RunInputReceiptSchema.parse({
        inputId: ID,
        runId: RUN_ID,
        acceptedSequence: 2,
        stage: "RECORDED",
        acceptedAt: 5,
        messageId: "msg_1",
      }),
    ).toMatchObject({ stage: "RECORDED" });
    expect(
      RunInputReceiptSchema.safeParse({
        inputId: ID,
        runId: RUN_ID,
        acceptedSequence: 2,
        stage: "APPLIED",
        acceptedAt: 5,
      }).success,
    ).toBe(false);
    // Never the text: a receipt is a metadata projection.
    expect(
      RunInputReceiptSchema.safeParse({
        inputId: ID,
        runId: RUN_ID,
        acceptedSequence: 1,
        stage: "PENDING",
        acceptedAt: 5,
        text: "secret",
      }).success,
    ).toBe(false);
  });

  it("bounds the list page and defaults its limit", () => {
    expect(RunInputListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(RunInputListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(RunInputListQuerySchema.safeParse({ after: 0 }).success).toBe(false);
  });

  it("advertises the capability and registers both metadata events", () => {
    const info = DaemonInfoSchema.parse({
      apiVersion: "v1",
      protocolVersion: 1,
      daemonVersion: "test",
      capabilities: {
        runExecution: true,
        runRecovery: true,
        cancellation: true,
        approvals: true,
        sseReplay: true,
        runInputV1: true,
      },
      runtimeKinds: ["local"],
      configuredProviders: [],
      defaultRunConfiguration: {
        runtime: { id: "local", kind: "test" },
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ON_BOUNDARY",
        limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 1 },
      },
    });
    expect(info.capabilities.runInputV1).toBe(true);

    const catalogTypes = RUN_EVENT_TYPE_CATALOG.map((definition) => definition.type);
    expect(catalogTypes).toContain("run.input.accepted");
    expect(catalogTypes).toContain("run.input.assigned");
    expect(RunEventSchemaRegistryInstance.supports("run.input.accepted", 1)).toBe(true);
    expect(RunEventSchemaRegistryInstance.supports("run.input.assigned", 1)).toBe(true);
    expect(() => RunEventSchemaRegistryInstance.parse({ type: "run.input.accepted" })).toThrow(
      RunEventSchemaDecodeError,
    );
  });

  it("decodes the accepted event without any user content", () => {
    const parsed = RunEventSchemaRegistryInstance.parse({
      eventId: "evt_0195f3a0-0000-7000-8000-000000000001",
      schemaVersion: 1,
      runId: RUN_ID,
      sessionId: "ses_0195f3a0-0000-7000-8000-000000000001",
      timestamp: 1,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 3 },
      type: "run.input.accepted",
      payload: { inputId: ID, acceptedSequence: 1 },
    });
    expect(parserPayload(parsed)).toEqual({ inputId: ID, acceptedSequence: 1 });
  });
});

function parserPayload(event: unknown): unknown {
  return (event as { readonly payload?: unknown }).payload;
}
