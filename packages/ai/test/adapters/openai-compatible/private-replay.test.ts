import { describe, expect, it } from "vitest";
import { createDeepSeekPrivateReplayCapture } from "../../../src/adapters/openai-compatible/private-replay.js";
import {
  decodeDeepSeekNativeReplayPayload,
  deepSeekReplayConnectionFingerprint,
} from "../../../src/adapters/openai-compatible/private-replay.js";

const fingerprint = "a".repeat(64);
const rawReasoning = (reasoning: unknown) => ({
  choices: [{ index: 0, delta: { reasoning_content: reasoning } }],
});

describe("DeepSeek native replay capture", () => {
  it("binds replay to endpoint and provider/model compatibility profiles", () => {
    const endpoint = deepSeekReplayConnectionFingerprint({
      endpoint: "https://one.example/v1",
      queryParams: {},
    });
    const same = deepSeekReplayConnectionFingerprint({
      endpoint: "https://one.example/v1",
      queryParams: {},
    });
    const otherEndpoint = deepSeekReplayConnectionFingerprint({
      endpoint: "https://two.example/v1",
      queryParams: {},
    });
    const profile = deepSeekReplayConnectionFingerprint(
      { endpoint: "https://one.example/v1", queryParams: {} },
      { requiresReasoningReplayWithTools: true },
    );
    expect(endpoint === same && endpoint !== otherEndpoint && endpoint !== profile).toBe(true);
  });

  it("bounds Tool metadata count before a COMPLETE replay can be emitted", () => {
    const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: false });
    for (let index = 0; index < 1025; index += 1) capture.startTool(`call-${index}`, "read_file");
    expect(capture.finalize("deepseek", "deepseek-reasoner", fingerprint).completeness).toBe(
      "INCOMPLETE",
    );
    capture.dispose();
  });

  it("aggregates Unicode deltas and treats null placeholders as absent deltas", () => {
    const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: true });
    const chunks = ["private ", "雪", "😀", " content".repeat(8192)];
    for (const chunk of chunks) capture.observeRawReasoning(rawReasoning(chunk));
    capture.observeRawReasoning(rawReasoning(null));
    const result = capture.finalize("deepseek", "deepseek-reasoner", fingerprint);
    expect(result.completeness).toBe("COMPLETE");
    if (result.completeness !== "COMPLETE") throw new Error("expected complete replay");
    const decoded = decodeDeepSeekNativeReplayPayload(result.payload);
    expect(
      decoded?.reasoning.state === "PRESENT" && decoded.reasoning.content === chunks.join(""),
    ).toBe(true);
    result.payload.fill(0);
    capture.dispose();
  });

  it.each([false, true])(
    "distinguishes absent from present empty reasoning (required=%s)",
    (required) => {
      const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: required });
      if (!required) {
        const absent = capture.finalize("deepseek", "deepseek-reasoner", fingerprint);
        expect(absent.completeness).toBe("COMPLETE");
        if (absent.completeness !== "COMPLETE") throw new Error("expected complete replay");
        expect(decodeDeepSeekNativeReplayPayload(absent.payload)?.reasoning.state).toBe("ABSENT");
        absent.payload.fill(0);
      }
      capture.observeRawReasoning(rawReasoning(""));
      const empty = capture.finalize("deepseek", "deepseek-reasoner", fingerprint);
      expect(empty.completeness).toBe("COMPLETE");
      if (empty.completeness !== "COMPLETE") throw new Error("expected complete replay");
      const decoded = decodeDeepSeekNativeReplayPayload(empty.payload);
      expect(decoded?.reasoning.state === "PRESENT" && decoded.reasoning.content === "").toBe(true);
      empty.payload.fill(0);
      capture.dispose();
    },
  );

  it("rejects reasoning belonging to a different Provider choice", () => {
    const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: true });
    capture.observeRawReasoning({
      choices: [{ index: 1, delta: { reasoning_content: "private" } }],
    });
    expect(capture.finalize("deepseek", "deepseek-reasoner", fingerprint).completeness).toBe(
      "INCOMPLETE",
    );
  });

  it("rejects unknown fields instead of reinterpreting a future payload shape", () => {
    const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: true });
    capture.observeRawReasoning(rawReasoning("private"));
    const result = capture.finalize("deepseek", "deepseek-reasoner", fingerprint);
    if (result.completeness !== "COMPLETE") throw new Error("expected complete replay");
    const payload = JSON.parse(new TextDecoder().decode(result.payload)) as Record<string, unknown>;
    const extended = new TextEncoder().encode(
      JSON.stringify({ ...payload, futureField: "ignored" }),
    );
    expect(decodeDeepSeekNativeReplayPayload(extended) === undefined).toBe(true);
    result.payload.fill(0);
    extended.fill(0);
    capture.dispose();
  });

  it.each([
    "missing-reasoning",
    "overflow",
    "disposed",
    "wrong-id",
    "wrong-name",
    "different-input",
  ])("fails closed for %s", (mode) => {
    const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: true });
    if (mode !== "missing-reasoning") capture.observeRawReasoning(rawReasoning("private"));
    if (mode === "overflow") capture.observeRawReasoning(rawReasoning("x".repeat(8 * 1024 * 1024)));
    if (mode === "disposed") capture.dispose();
    if (mode === "wrong-id" || mode === "wrong-name" || mode === "different-input") {
      capture.startTool("call-a", "read_file");
      capture.appendTool("call-a", '{"path":"a"}');
      capture.completeTool(
        mode === "wrong-id" ? "call-b" : "call-a",
        mode === "wrong-name" ? "apply_patch" : "read_file",
        { path: mode === "different-input" ? "b" : "a" },
      );
    }
    expect(capture.finalize("deepseek", "deepseek-reasoner", fingerprint).completeness).toBe(
      "INCOMPLETE",
    );
    capture.dispose();
  });

  it("retains Tool Call start order when interleaved argument streams complete out of order", () => {
    const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: false });
    capture.startTool("call-a", "apply_patch");
    capture.startTool("call-b", "read_file");
    capture.appendTool("call-b", '{"path":"b"}');
    capture.appendTool("call-a", '{"path":"a","content":"x"}');
    capture.completeTool("call-b", "read_file", { path: "b" });
    capture.completeTool("call-a", "apply_patch", { path: "a", content: "x" });

    const candidate = capture.finalize("deepseek", "deepseek-reasoner", "a".repeat(64));
    expect(candidate.completeness).toBe("COMPLETE");
    if (candidate.completeness !== "COMPLETE") throw new Error("capture was incomplete");
    const payload = JSON.parse(new TextDecoder().decode(candidate.payload)) as {
      toolCalls: readonly { id: string }[];
    };
    expect(payload.toolCalls.map((call) => call.id)).toEqual(["call-a", "call-b"]);
    candidate.payload.fill(0);
    capture.dispose();
  });

  it("rejects a tool call that never received a complete argument input", () => {
    const capture = createDeepSeekPrivateReplayCapture({ requireReasoning: false });
    capture.startTool("call-a", "read_file");
    capture.appendTool("call-a", '{"path":"partial"');
    expect(capture.finalize("deepseek", "deepseek-reasoner", "a".repeat(64))).toEqual({
      completeness: "INCOMPLETE",
    });
    capture.dispose();
  });
});
