import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

type Schema = { safeParse(value: unknown): { success: boolean }; parse(value: unknown): unknown };
function schema(name: string): Schema {
  const value = (protocol as Record<string, unknown>)[name];
  expect(value, `${name} must be publicly exported`).toBeDefined();
  return value as Schema;
}

describe("archive management contracts", () => {
  it("keeps an unknown archive time as an archived episode", () => {
    const episode = { archiveId: randomUUID(), archivedAt: null, reason: "USER" };
    expect(schema("ArchiveEpisodeSchema").parse(episode)).toEqual(episode);
    expect(
      schema("ArchiveStateSchema").safeParse({
        target: { type: "SESSION", sessionId: protocol.createSessionId() },
        archived: true,
        ownArchive: episode,
        restoreDisposition: "AVAILABLE",
      }).success,
    ).toBe(true);
  });

  it("rejects forged normal state with an archived parent", () => {
    expect(
      schema("ArchiveStateSchema").safeParse({
        target: { type: "SESSION", sessionId: protocol.createSessionId() },
        archived: false,
        parentWorkspace: {
          workspaceId: protocol.createWorkspaceId(),
          archive: {
            archiveId: randomUUID(),
            archivedAt: 10,
            reason: "USER",
          },
        },
        restoreDisposition: "NOT_ARCHIVED",
      }).success,
    ).toBe(false);
  });

  it("bounds queries and defaults the page size", () => {
    const list = schema("ArchiveSessionListQuerySchema");
    expect(list.parse({})).toEqual({ limit: 50 });
    for (const limit of [1, 100]) expect(list.safeParse({ limit }).success).toBe(true);
    for (const limit of [0, 101, 1.5]) expect(list.safeParse({ limit }).success).toBe(false);
    expect(list.safeParse({ query: "a".repeat(200) }).success).toBe(true);
    expect(list.safeParse({ query: "a".repeat(201) }).success).toBe(false);
    expect(
      list.safeParse({ workspaceId: protocol.createWorkspaceId(), unassociated: true }).success,
    ).toBe(false);
  });

  it("accepts only strict target and deletion shapes", () => {
    const target = { type: "SESSION", sessionId: protocol.createSessionId() };
    expect(schema("ArchiveTargetSchema").safeParse(target).success).toBe(true);
    expect(schema("ArchiveTargetSchema").safeParse({ ...target, path: "D:/project" }).success).toBe(
      false,
    );
    expect(
      schema("ArchiveDeletionSelectionSchema").safeParse({ type: "SESSION_FILTER", filter: {} })
        .success,
    ).toBe(true);
    expect(
      schema("PermanentDeletionRequestSchema").safeParse({
        confirmationToken: "signed",
        sessionId: target.sessionId,
      }).success,
    ).toBe(false);
  });

  it("bounds migration batches and deletion preview samples", () => {
    const marker = { sessionId: protocol.createSessionId(), archivedAt: 10 };
    expect(
      schema("LegacyArchiveImportRequestSchema").safeParse({ markers: Array(100).fill(marker) })
        .success,
    ).toBe(true);
    expect(
      schema("LegacyArchiveImportRequestSchema").safeParse({ markers: Array(101).fill(marker) })
        .success,
    ).toBe(false);
    const preview = {
      counts: { sessions: 4, workspaces: 0, runs: 0 },
      confirmationToken: "signed",
      expiresAt: 10,
      samples: Array(4).fill({ type: "SESSION", label: "Example" }),
    };
    expect(schema("ArchiveDeletionPreviewResponseSchema").safeParse(preview).success).toBe(false);
  });
});
