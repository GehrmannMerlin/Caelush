import { describe, expect, it } from "vitest";
import {
  MAX_SECRET_JSON_DEPTH,
  MAX_SECRET_JSON_NODES,
  MAX_SECRET_SCAN_TEXT_BYTES,
  detectSecrets,
  redactJson,
  redactText,
} from "../src/index.js";

describe("deterministic secret detection and redaction", () => {
  it("redacts high-confidence secret forms without exposing partial values", () => {
    const text = [
      "OPENAI_API_KEY=fake-api-value-123456",
      "Authorization: Bearer fake-bearer-value-123456",
      "Authorization: Basic ZmFrZTpwYXNzd29yZA==",
      "https://user:fake-password@example.test/?token=fake-query-value",
      "-----BEGIN PRIVATE KEY-----\nfake-key-body\n-----END PRIVATE KEY-----",
      "provider=sk-fake-provider-token-1234567890",
    ].join("\n");

    const redacted = redactText(text);

    expect(redacted).not.toContain("fake-api-value");
    expect(redacted).not.toContain("fake-bearer-value");
    expect(redacted).not.toContain("fake-password");
    expect(redacted).not.toContain("fake-query-value");
    expect(redacted).not.toContain("fake-key-body");
    expect(redacted).not.toContain("sk-fake-provider-token");
    expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("-----BEGIN PRIVATE KEY-----\n[REDACTED]");
    expect(redacted).toBe(redactText(redacted));
  });

  it("redacts nested JSON values by sensitive key and scans ordinary strings", () => {
    const value = {
      password: "fake-password-value",
      nested: { access_token: "fake-token-value", ok: "DEBUG=true" },
      values: ["TOKEN=fake-array-value", 3, false, null],
    } as const;

    expect(redactJson(value)).toEqual({
      password: "[REDACTED]",
      nested: { access_token: "[REDACTED]", ok: "DEBUG=true" },
      values: ["TOKEN=[REDACTED]", 3, false, null],
    });
  });

  it("does not redact explicit placeholders as if they were secrets", () => {
    const text = "key=YOUR_API_KEY token=<token> secret=placeholder value=REDACTED";
    expect(redactText(text)).toBe(text);
    expect(detectSecrets(text).count).toBe(0);
  });

  it("replaces text and JSON subtrees that exceed deterministic scan bounds", () => {
    expect(redactText("x".repeat(MAX_SECRET_SCAN_TEXT_BYTES + 1))).toBe(
      "[REDACTED:SCAN_LIMIT]",
    );
    let deeplyNested: unknown = "secret-value";
    for (let index = 0; index <= MAX_SECRET_JSON_DEPTH; index += 1) {
      deeplyNested = { child: deeplyNested };
    }
    expect(JSON.stringify(redactJson(deeplyNested))).toContain("[REDACTED:SCAN_LIMIT]");

    const manyNodes = Array.from({ length: MAX_SECRET_JSON_NODES + 1 }, () => "value");
    expect(JSON.stringify(redactJson(manyNodes))).toContain("[REDACTED:SCAN_LIMIT]");
  });
});
