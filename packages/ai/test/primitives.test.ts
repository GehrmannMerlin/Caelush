import { describe, expect, it } from "vitest";
import { API_ID_PATTERN, RESERVED_API_IDS, isValidApiId } from "../src/ids/api-id.js";
import { LLM_CALL_ID_PATTERN, createLLMCallId, isLLMCallId } from "../src/ids/llm-call-id.js";
import { PROVIDER_ID_PATTERN, isValidProviderId } from "../src/ids/provider-id.js";
import { sameModelIdentity } from "../src/models/model-ref.js";
import type { JsonObject, JsonValue } from "../src/json/json-value.js";
import type { ModelRef } from "../src/models/model-ref.js";

describe("AI-local JSON types", () => {
  it("describes a JSON object without any protocol dependency", () => {
    const value: JsonObject = {
      text: "hello",
      count: 2,
      enabled: true,
      missing: null,
      nested: { list: [1, "two", false, null] },
    };

    expect(value).toEqual({
      text: "hello",
      count: 2,
      enabled: true,
      missing: null,
      nested: { list: [1, "two", false, null] },
    });
  });

  it("keeps JsonValue assignable from readonly arrays", () => {
    const list: readonly JsonValue[] = [{ a: 1 }, "b"];

    expect(list).toHaveLength(2);
  });
});

describe("provider and api identifiers", () => {
  it("accepts the frozen identifier shape", () => {
    for (const value of ["a", "openai", "openai-compatible", "open_ai_2", "x-1_y"]) {
      expect(isValidProviderId(value)).toBe(true);
      expect(isValidApiId(value)).toBe(true);
    }
  });

  it("rejects identifiers that violate the frozen pattern", () => {
    for (const value of [
      "",
      "A",
      "1openai",
      "-openai",
      "_openai",
      "openai compatible",
      "openai.ai",
    ]) {
      expect(isValidProviderId(value)).toBe(false);
      expect(isValidApiId(value)).toBe(false);
    }
  });

  it("keeps the frozen pattern and reserved api dialects", () => {
    expect(PROVIDER_ID_PATTERN.source).toBe(API_ID_PATTERN.source);
    expect(PROVIDER_ID_PATTERN.source).toBe("^[a-z][a-z0-9_-]*$");
    expect(RESERVED_API_IDS).toEqual(["openai-compatible-chat", "anthropic-messages"]);
    for (const api of RESERVED_API_IDS) expect(isValidApiId(api)).toBe(true);
  });

  it("treats provider and api ids as the same structural string type", () => {
    const provider: string = "openai";
    const api: string = "openai-compatible-chat";

    expect(isValidProviderId(api)).toBe(true);
    expect(isValidApiId(provider)).toBe(true);
  });
});

describe("AI-local LLMCallId", () => {
  it("creates a llm_<UUIDv7> identity", () => {
    const callId = createLLMCallId();

    expect(callId.startsWith("llm_")).toBe(true);
    expect(isLLMCallId(callId)).toBe(true);
    expect(LLM_CALL_ID_PATTERN.test(callId)).toBe(true);
  });

  it("creates a distinct identity per call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createLLMCallId()));

    expect(ids.size).toBe(50);
  });

  it("rejects non UUIDv7 identities", () => {
    expect(isLLMCallId("llm_00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(isLLMCallId("00000000-0000-7000-8000-000000000000")).toBe(false);
    expect(isLLMCallId("call_0195f3a0-0000-7000-8000-000000000000")).toBe(false);
  });
});

describe("ModelRef identity", () => {
  it("ignores baseUrl for identity", () => {
    const left: ModelRef = { provider: "openai", model: "gpt-5", baseUrl: "https://a.example" };
    const right: ModelRef = { provider: "openai", model: "gpt-5", baseUrl: "https://b.example" };

    expect(sameModelIdentity(left, right)).toBe(true);
  });

  it("compares provider and model only", () => {
    const base: ModelRef = { provider: "openai", model: "gpt-5" };

    expect(sameModelIdentity(base, { provider: "openai", model: "gpt-5" })).toBe(true);
    expect(sameModelIdentity(base, { provider: "openai", model: "gpt-5-mini" })).toBe(false);
    expect(sameModelIdentity(base, { provider: "azure", model: "gpt-5" })).toBe(false);
    expect(
      sameModelIdentity(
        { provider: "openai", model: "gpt-5", baseUrl: "https://a.example" },
        { provider: "azure", model: "gpt-5" },
      ),
    ).toBe(false);
  });
});
