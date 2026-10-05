import { describe, expect, it } from "vitest";
import {
  MAX_SECRET_JSON_DEPTH,
  MAX_SECRET_JSON_NODES,
  MAX_SECRET_SCAN_TEXT_BYTES,
  detectSecrets,
  redactJson,
  redactText,
  tryRedactJson,
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
    expect(redactText("x".repeat(MAX_SECRET_SCAN_TEXT_BYTES + 1))).toBe("[REDACTED:SCAN_LIMIT]");
    let deeplyNested: unknown = "secret-value";
    for (let index = 0; index <= MAX_SECRET_JSON_DEPTH; index += 1) {
      deeplyNested = { child: deeplyNested };
    }
    expect(JSON.stringify(redactJson(deeplyNested))).toContain("[REDACTED:SCAN_LIMIT]");

    const manyNodes = Array.from({ length: MAX_SECRET_JSON_NODES + 1 }, () => "value");
    expect(JSON.stringify(redactJson(manyNodes))).toContain("[REDACTED:SCAN_LIMIT]");
  });
});

describe("bounded non-destructive JSON redaction", () => {
  it("preserves JSON value types while redacting strings and sensitive keys", () => {
    const outcome = tryRedactJson(
      {
        password: "fake-password-value",
        nested: { note: "TOKEN=SECRET_TOKEN_12345678", count: 3, enabled: false },
        values: [null, 7, true],
      },
      { maxNodes: 20, maxDepth: 8, maxTextBytes: 64 },
    );

    expect(outcome.kind).toBe("REDACTED");
    if (outcome.kind !== "REDACTED") throw new Error("expected successful redaction");
    expect(outcome.value).toEqual({
      password: "[REDACTED]",
      nested: { note: "TOKEN=[REDACTED]", count: 3, enabled: false },
      values: [null, 7, true],
    });
    expect(outcome.report.nodesScanned).toBe(10);
    expect(outcome.report.redactionCount).toBeGreaterThan(0);
  });

  it("accepts exactly the node budget and refuses one node over without a partial value", () => {
    const exact = tryRedactJson(
      Array.from({ length: 4 }, () => null),
      {
        maxNodes: 5,
        maxDepth: 8,
        maxTextBytes: 64,
      },
    );
    const over = tryRedactJson(
      Array.from({ length: 5 }, () => null),
      {
        maxNodes: 5,
        maxDepth: 8,
        maxTextBytes: 64,
      },
    );

    expect(exact).toMatchObject({ kind: "REDACTED", report: { nodesScanned: 5 } });
    expect(over).toEqual({ kind: "LIMIT_EXCEEDED", reason: "SCAN_NODE_LIMIT" });
    expect(over).not.toHaveProperty("value");
  });

  it("redacts a secret at the last permitted node", () => {
    const outcome = tryRedactJson([null, "token=SECRET_TOKEN_12345678"], {
      maxNodes: 3,
      maxDepth: 8,
      maxTextBytes: 64,
    });

    expect(outcome).toMatchObject({
      kind: "REDACTED",
      value: [null, "token=[REDACTED]"],
      report: { nodesScanned: 3 },
    });
  });

  it("refuses excessive depth and text length without replacing values", () => {
    expect(tryRedactJson({ child: { value: null } }, { maxNodes: 10, maxDepth: 1 })).toEqual({
      kind: "LIMIT_EXCEEDED",
      reason: "SCAN_DEPTH_LIMIT",
    });
    expect(tryRedactJson("x".repeat(5), { maxNodes: 10, maxDepth: 8, maxTextBytes: 4 })).toEqual({
      kind: "LIMIT_EXCEEDED",
      reason: "TEXT_LIMIT",
    });
  });

  it("refuses cycles without throwing and permits acyclic shared references", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => tryRedactJson(cyclic)).not.toThrow(RangeError);
    expect(tryRedactJson(cyclic)).toEqual({
      kind: "LIMIT_EXCEEDED",
      reason: "SCAN_DEPTH_LIMIT",
    });

    const shared = { value: "safe" };
    expect(tryRedactJson([shared, shared])).toMatchObject({
      kind: "REDACTED",
      value: [{ value: "safe" }, { value: "safe" }],
    });
  });
});
