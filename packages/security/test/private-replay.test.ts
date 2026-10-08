import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReplayProtection, createInjectedReplayKeyProvider } from "../src/private-replay.js";

const identity = {
  sessionId: "session",
  runId: "run",
  messageId: "message",
  callId: "call",
  providerId: "provider",
  model: "model",
  api: "api",
  replayVersion: 1 as const,
};
const secret = () => new TextEncoder().encode("C3_PRIVATE_REASONING_SENTINEL 中文");

describe("private replay authenticated encryption", () => {
  it("recovers with the same injected persistent key and uses distinct nonces", async () => {
    const key = randomBytes(32);
    const protection = createReplayProtection(createInjectedReplayKeyProvider("key-1", key));
    const first = await protection.seal(identity, secret());
    const second = await protection.seal(identity, secret());
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.contentMac).toBe(second.contentMac);
    expect(JSON.stringify(first).includes("C3_PRIVATE_REASONING_SENTINEL")).toBe(false);
    const reopened = createReplayProtection(createInjectedReplayKeyProvider("key-1", key));
    const restored = await reopened.open(identity, first);
    const expected = secret();
    const matches = Buffer.from(restored).equals(expected);
    restored.fill(0);
    expected.fill(0);
    expect(matches).toBe(true);
  });

  it("fails closed for wrong or missing keys and sanitized provider failures", async () => {
    const protection = createReplayProtection(
      createInjectedReplayKeyProvider("key-1", randomBytes(32)),
    );
    const sealed = await protection.seal(identity, secret());
    const wrong = createReplayProtection(createInjectedReplayKeyProvider("key-1", randomBytes(32)));
    await expect(wrong.open(identity, sealed)).rejects.toThrow("Private replay unavailable.");
    const missing = createReplayProtection({
      current: async () => {
        throw new Error("C3_PRIVATE_REASONING_SENTINEL");
      },
      get: async () => undefined,
    });
    await expect(missing.seal(identity, secret())).rejects.toThrow(
      /^Private replay unavailable\.$/,
    );
    await expect(missing.open(identity, sealed)).rejects.toThrow(/^Private replay unavailable\.$/);
  });

  it("authenticates every identity field, ciphertext, tag, nonce and version", async () => {
    const protection = createReplayProtection(
      createInjectedReplayKeyProvider("key-1", randomBytes(32)),
    );
    const sealed = await protection.seal(identity, secret());
    for (const field of [
      "sessionId",
      "runId",
      "messageId",
      "callId",
      "providerId",
      "model",
      "api",
    ] as const) {
      await expect(protection.open({ ...identity, [field]: "other" }, sealed)).rejects.toThrow(
        "Private replay unavailable.",
      );
    }
    for (const field of ["ciphertext", "tag", "nonce", "contentMac"] as const) {
      const bytes = Buffer.from(sealed[field], "base64");
      bytes[0] = bytes[0]! ^ 1;
      await expect(
        protection.open(identity, { ...sealed, [field]: bytes.toString("base64") }),
      ).rejects.toThrow("Private replay unavailable.");
    }
    await expect(protection.open(identity, { ...sealed, version: 2 } as never)).rejects.toThrow(
      "Private replay unavailable.",
    );
    await expect(
      protection.seal({ ...identity, replayVersion: 2 } as never, secret()),
    ).rejects.toThrow("Private replay unavailable.");
  });

  it("rejects oversized content without truncation", async () => {
    const protection = createReplayProtection(
      createInjectedReplayKeyProvider("key-1", randomBytes(32)),
    );
    await expect(protection.seal(identity, new Uint8Array(8 * 1024 * 1024 + 1))).rejects.toThrow(
      "Private replay unavailable.",
    );
  });
});
