import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageTranscriptProjectorRegistry,
  projectionVersionTable,
} from "@caelush/agent";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";

import { buildDaemonApp } from "../src/index.js";
import { SessionTranscriptService } from "../src/services/session-transcript-service.js";

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Session transcript route", () => {
  it("returns the typed transcript response and a typed missing-session error", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-transcript-route-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const app = buildDaemonApp({
      sessions: storage.sessions,
      runs: storage.runs,
      eventHub: { watch: async function* () {} } as never,
      config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
      transcript: new SessionTranscriptService({
        sessions: storage.sessions,
        runs: storage.runs,
        messageRecords: storage.messageRecords,
        codecs: createStandardAgentMessageCodecRegistry(
          projectionVersionTable({ USER: 1, ASSISTANT: 1, TOOL_RESULT: 1 }),
        ),
        transcriptProjectors: createStandardAgentMessageTranscriptProjectorRegistry(),
      }),
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {},
    });
    const sessionId = created.json().id as string;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/transcript?limit=10`,
      headers: { host: "127.0.0.1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/ses_00000000-0000-7000-8000-000000000000/transcript",
      headers: { host: "127.0.0.1" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });
});
