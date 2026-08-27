import { describe, expect, it } from "vitest";
import { AgentSessionSchema, createSessionId, createTimestampMs } from "@caelush/protocol";
import { decodeProtocol, encodeProtocol } from "../src/codec.js";
import { StorageDecodeError } from "../src/errors.js";

const session = {
  id: createSessionId(),
  createdAt: createTimestampMs(1),
  updatedAt: createTimestampMs(2),
  metadata: { source: "test" },
};

describe("Protocol storage codec", () => {
  it("round-trips a valid Protocol value", () => {
    const encoded = encodeProtocol(AgentSessionSchema, session, {
      entityType: "AgentSession",
      entityId: session.id,
      table: "agent_sessions",
    });

    expect(
      decodeProtocol(AgentSessionSchema, encoded, {
        entityType: "AgentSession",
        entityId: session.id,
        table: "agent_sessions",
      }),
    ).toEqual(session);
  });

  it("rejects invalid values before they are encoded", () => {
    expect(() =>
      encodeProtocol(AgentSessionSchema, { ...session, metadata: "bad" } as never, {
        entityType: "AgentSession",
        entityId: session.id,
        table: "agent_sessions",
      }),
    ).toThrow(StorageDecodeError);
  });

  it("fails fast for malformed JSON and schema drift with storage context", () => {
    expect(() =>
      decodeProtocol(AgentSessionSchema, "{", {
        entityType: "AgentSession",
        entityId: session.id,
        table: "agent_sessions",
      }),
    ).toThrowError(/AgentSession.*agent_sessions/);

    expect(() =>
      decodeProtocol(AgentSessionSchema, JSON.stringify({ id: session.id }), {
        entityType: "AgentSession",
        entityId: session.id,
        table: "agent_sessions",
      }),
    ).toThrow(StorageDecodeError);
  });
});
