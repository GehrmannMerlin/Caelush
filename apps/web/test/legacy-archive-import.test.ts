import { describe, expect, it } from "vitest";
import {
  createSessionId,
  type LegacyArchiveImportRequest,
  type LegacyArchiveImportResponse,
} from "@caelush/protocol";
import { SessionArchiveStore } from "../src/application/session-archive-store.js";
import { importLegacySessionArchives } from "../src/application/legacy-archive-import.js";
describe("legacy sidebar archive migration", () => {
  it("imports 201 markers in bounded batches and acknowledges only current-profile successes", async () => {
    const markers = Array.from({ length: 201 }, (_, i) => ({
      sessionId: createSessionId(),
      archivedAt: i,
    }));
    let raw = JSON.stringify(markers);
    const store = new SessionArchiveStore({
      getItem: () => raw,
      setItem: (_key, value) => {
        raw = value;
      },
    });
    const sizes: number[] = [];
    const client = {
      importLegacyArchives: async (
        input: LegacyArchiveImportRequest,
      ): Promise<LegacyArchiveImportResponse> => {
        sizes.push(input.markers.length);
        return {
          importedSessionIds: input.markers.map((m) => m.sessionId),
          alreadyArchivedSessionIds: [],
          rejected: [],
          catalogRevision: 1,
        };
      },
    };
    const one = importLegacySessionArchives({ client, store });
    const two = importLegacySessionArchives({ client, store });
    expect(await one).toEqual({ imported: 201, deferred: 0 });
    expect(await two).toEqual({ imported: 201, deferred: 0 });
    expect(sizes).toEqual([100, 100, 1]);
    expect(store.list()).toEqual([]);
  });
  it("retains foreign, running and malformed markers, including across retries", async () => {
    const owned = createSessionId(),
      foreign = createSessionId(),
      running = createSessionId();
    let raw = JSON.stringify([
      { sessionId: owned, archivedAt: 1 },
      { sessionId: foreign, archivedAt: 2 },
      { sessionId: running, archivedAt: 3 },
      { broken: true },
    ]);
    const store = new SessionArchiveStore({
      getItem: () => raw,
      setItem: (_key, value) => {
        raw = value;
      },
    });
    const client = {
      importLegacyArchives: async (): Promise<LegacyArchiveImportResponse> => ({
        importedSessionIds: [],
        alreadyArchivedSessionIds: [owned],
        rejected: [
          { sessionId: foreign, reason: "NOT_OWNED" },
          { sessionId: running, reason: "ACTIVE_RUN_CONFLICT" },
        ],
        catalogRevision: 1,
      }),
    };
    expect(await importLegacySessionArchives({ client, store })).toEqual({
      imported: 1,
      deferred: 2,
    });
    expect(store.list().map((m) => m.sessionId)).toEqual([running, foreign]);
    expect(JSON.parse(raw)).toContainEqual({ broken: true });
    const previous = raw;
    await expect(
      importLegacySessionArchives({
        client: {
          importLegacyArchives: async () => {
            throw new Error("network");
          },
        },
        store,
      }),
    ).rejects.toThrow("network");
    expect(raw).toBe(previous);
  });
});
