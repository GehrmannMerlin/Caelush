import { describe, expect, it } from "vitest";
import {
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageTranscriptProjectorRegistry,
  projectionVersionTable,
} from "@caelush/agent";
import { createSessionId, createTimestampMs, type AgentSession } from "@caelush/protocol";
import { SessionTranscriptService } from "../src/services/session-transcript-service.js";
import { SessionPresentationService } from "../src/services/session-presentation-service.js";
import { ArchiveInvalidator } from "../src/services/archive-invalidation.js";
describe("deleted history invalidation", () => {
  it("delegates only the committed deleted Run identities", () => {
    const ids: unknown[] = [];
    const invalidator = new ArchiveInvalidator({
      eventHub: {
        invalidateRuns: (runs) => {
          ids.push(runs);
        },
      },
    });
    invalidator.invalidate({
      response: { counts: { workspaces: 0, sessions: 0, runs: 0 }, catalogRevision: 1 },
      deletedRunIds: [],
      deletedSessionIds: [],
      deletedWorkspaceIds: [],
    });
    expect(ids).toEqual([[]]);
  });
  it.each(["TRANSCRIPT", "PRESENTATION"] as const)(
    "refuses stale %s projection after asynchronous reads",
    async (kind) => {
      const session: AgentSession = {
        id: createSessionId(),
        createdAt: createTimestampMs(1),
        updatedAt: createTimestampMs(1),
        metadata: {},
      };
      let deleted = false;
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const options = {
        sessions: { get: async () => (deleted ? null : session) },
        runs: { listBySession: async () => [] },
        messageRecords: {
          listBySession: async () => {
            entered();
            await gate;
            return [];
          },
        },
        codecs: createStandardAgentMessageCodecRegistry(
          projectionVersionTable({ USER: 1, ASSISTANT: 1, TOOL_RESULT: 1 }),
        ),
      };
      const response =
        kind === "TRANSCRIPT"
          ? new SessionTranscriptService({
              ...options,
              transcriptProjectors: createStandardAgentMessageTranscriptProjectorRegistry(),
            }).getTranscript(session.id, { limit: 50 })
          : new SessionPresentationService({
              ...options,
              eventReader: {} as never,
              toolInvocations: {} as never,
              observations: {} as never,
              toolPresentation: {} as never,
            }).getPresentation(session.id, { limit: 50 });
      await started;
      deleted = true;
      release();
      await expect(response).rejects.toMatchObject({ name: "StorageNotFoundError" });
    },
  );
});
