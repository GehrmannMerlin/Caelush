import { describe, expect, it } from "vitest";
import { createSessionId } from "@caelush/protocol";
import { createArchiveConfirmationCodec } from "../src/services/archive-confirmation.js";
describe("archive deletion confirmation", () => {
  it("binds scope, key, digest and selection and expires exactly at ten minutes", () => {
    let now = 100;
    const key = new Uint8Array(32).fill(7);
    const codec = createArchiveConfirmationCodec({ scopeId: "profile-1", key, now: () => now });
    const snapshot = {
      selection: { type: "SESSION" as const, sessionId: createSessionId() },
      digest: "a".repeat(64),
      counts: { workspaces: 0, sessions: 1, runs: 2 },
      samples: [],
    };
    const issued = codec.issue(snapshot);
    expect(issued.expiresAt).toBe(600100);
    expect(issued.token.length).toBeLessThan(2000);
    expect(codec.verify(issued.token)).toEqual({
      selection: snapshot.selection,
      digest: snapshot.digest,
    });
    const [payload, signature] = issued.token.split(".");
    expect(() => codec.verify(`${payload}.${signature!.slice(0, -1)}!`)).toThrow();
    expect(() =>
      createArchiveConfirmationCodec({ scopeId: "profile-2", key, now: () => now }).verify(
        issued.token,
      ),
    ).toThrow();
    expect(() =>
      createArchiveConfirmationCodec({
        scopeId: "profile-1",
        key: new Uint8Array(32).fill(8),
        now: () => now,
      }).verify(issued.token),
    ).toThrow();
    now = 600099;
    expect(codec.verify(issued.token).digest).toBe(snapshot.digest);
    now = 600100;
    expect(() => codec.verify(issued.token)).toThrow(
      expect.objectContaining({ code: "ARCHIVE_CONFIRMATION_EXPIRED" }),
    );
  });
});
