import {
  PublicRunEventSchema,
  ClientAgentSessionSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  CaelushClient,
  CaelushClientHttpError,
  CaelushClientProtocolError,
  CaelushProtocolCompatibilityError,
} from "../src/client.js";

function makeSession() {
  return ClientAgentSessionSchema.parse({
    id: createSessionId(),
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  });
}

function makeEvent(
  runId: ReturnType<typeof createRunId>,
  sequence: number,
  kind: "DURABLE" | "EPHEMERAL",
) {
  return PublicRunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId: createSessionId(),
    type: "shell.output",
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE",
    durability:
      kind === "DURABLE" ? { kind: "DURABLE", version: 1, sequence } : { kind: "EPHEMERAL" },
    payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "hello 😀" },
  });
}

describe("CaelushClient", () => {
  it("loads and validates the Session Transcript through the canonical endpoint", async () => {
    const runId = createRunId();
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "message-1",
                runId,
                conversationTurnId: "turn-1",
                createdAt: 1,
                kind: "ASSISTANT",
                text: "answer",
              },
            ],
            nextCursor: "1",
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      client.getSessionTranscript("ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never, {
        limit: 10,
        cursor: "0",
      }),
    ).resolves.toMatchObject({ items: [{ kind: "ASSISTANT", text: "answer" }] });
    expect(requests[0]?.url).toBe(
      "http://daemon.test/api/v1/sessions/ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b/transcript?limit=10&cursor=0",
    );
  });

  it("loads the safe Session continuity preflight", async () => {
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ status: "POSSIBLE_INCOMPATIBILITY" }), {
          status: 200,
        });
      },
    });

    await expect(
      client.getSessionContinuityPreflight("ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never, {
        provider: "deepseek",
        model: "deepseek-reasoner",
      }),
    ).resolves.toEqual({ status: "POSSIBLE_INCOMPATIBILITY" });
    expect(requests[0]?.url).toBe(
      "http://daemon.test/api/v1/sessions/ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b/continuity-preflight?provider=deepseek&model=deepseek-reasoner",
    );
  });

  it("loads the ordered Session Turn Presentation snapshot", async () => {
    const runId = createRunId();
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(
          JSON.stringify({
            capabilityVersion: 1,
            highWatermark: 4,
            items: [
              {
                id: "assistant-1",
                runId,
                conversationTurnId: "turn-1",
                ordinal: 0,
                status: "COMPLETED",
                createdAt: 1,
                kind: "ASSISTANT",
                phase: "COMMENTARY",
                text: "先检查文件。",
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      client.getSessionTurnPresentation("ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never, {
        runId,
        limit: 10,
        cursor: "0",
      }),
    ).resolves.toMatchObject({
      highWatermark: 4,
      items: [{ kind: "ASSISTANT", phase: "COMMENTARY" }],
    });
    expect(requests[0]?.url).toBe(
      `http://daemon.test/api/v1/sessions/ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b/presentation?limit=10&runId=${encodeURIComponent(runId)}&cursor=0`,
    );
  });

  it("retains Session Turn Presentation v2 and its source step id", async () => {
    const runId = createRunId();
    const sourceStepId = createStepId();
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            capabilityVersion: 2,
            highWatermark: 5,
            items: [
              {
                id: "assistant-2",
                runId,
                conversationTurnId: "turn-2",
                ordinal: 0,
                status: "COMPLETED",
                createdAt: 1,
                kind: "ASSISTANT",
                phase: "FINAL_ANSWER",
                text: "answer",
                sourceStepId,
              },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(
      client.getSessionTurnPresentation("ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never),
    ).resolves.toMatchObject({
      capabilityVersion: 2,
      items: [{ kind: "ASSISTANT", sourceStepId }],
    });
  });

  it("parses turn-first Session Turn Presentation v3 without a Session watermark", async () => {
    const runId = createRunId();
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            capabilityVersion: 3,
            turns: [
              {
                runId,
                conversationTurnId: "turn-canonical",
                runStatus: "RUNNING",
                openedAt: 1,
                highWatermark: 7,
                items: [
                  {
                    id: "user-1",
                    runId,
                    conversationTurnId: "turn-canonical",
                    ordinal: 0,
                    status: "COMPLETED",
                    createdAt: 1,
                    kind: "USER",
                    text: "inspect",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(
      client.getSessionTurnPresentation("ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never),
    ).resolves.toMatchObject({
      capabilityVersion: 3,
      turns: [{ runId, highWatermark: 7, items: [{ kind: "USER", text: "inspect" }] }],
    });
  });

  it("binds the ambient browser fetch before invoking it", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: typeof globalThis) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            service: "caelush-daemon",
            status: "ready",
            apiVersion: "v1",
            protocolVersion: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    } as typeof fetch;
    try {
      await new CaelushClient({ baseUrl: "http://daemon.test" }).getHealth();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports the trusted same-origin Desktop app scheme for Main-proxied requests", async () => {
    const client = new CaelushClient({
      baseUrl: "caelush-app://app",
      fetch: async (input) => {
        expect(String(input)).toBe("caelush-app://app/api/v1/health");
        return new Response(
          JSON.stringify({
            service: "caelush-daemon",
            status: "ready",
            apiVersion: "v1",
            protocolVersion: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(client.getHealth()).resolves.toMatchObject({ status: "ready" });
    expect(() => new CaelushClient({ baseUrl: "caelush-app://other" })).toThrow(
      CaelushClientProtocolError,
    );
  });

  it("loads the safe Context Usage projection from the daemon", async () => {
    const runId = createRunId();
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            runId,
            providerId: "fixture",
            modelId: "small",
            contextWindowTokens: 1000,
            effectiveInputLimitTokens: 800,
            estimatedInputTokens: 200,
            usedRatio: 0.25,
            remainingTokens: 600,
            pressureState: "NORMAL",
            compactionCount: 0,
            breakdown: {
              pinned: 0,
              checkpoint: 0,
              recentTail: 100,
              project: 50,
              files: 50,
              toolObservations: 0,
              memory: 0,
            },
            updatedAt: 1,
          }),
          { status: 200 },
        ),
    });
    await expect(client.getRunContextUsage(runId)).resolves.toMatchObject({ usedRatio: 0.25 });
  });

  it("decodes the additive prompt-cache usage projection", async () => {
    const runId = createRunId();
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            runId,
            providerId: "fixture",
            modelId: "small",
            contextWindowTokens: 1000,
            effectiveInputLimitTokens: 800,
            estimatedInputTokens: 200,
            usedRatio: 0.25,
            remainingTokens: 600,
            pressureState: "NORMAL",
            compactionCount: 0,
            breakdown: {
              pinned: 0,
              checkpoint: 0,
              recentTail: 100,
              project: 50,
              files: 50,
              toolObservations: 0,
              memory: 0,
            },
            updatedAt: 1,
            promptCache: {
              status: "UNREPORTED",
              sampleCount: 0,
              totalRequestCount: 1,
              totalInputTokens: 100,
              totalOutputTokens: 2,
              hitTokens: 0,
              missTokens: 0,
              writeTokens: 0,
              unknownUsageCount: 1,
              expectedReusablePrefixTokens: 500,
              purposes: [
                {
                  purpose: "OTHER",
                  requestCount: 1,
                  inputTokens: 100,
                  outputTokens: 2,
                  hitTokens: 0,
                  missTokens: 0,
                  writeTokens: 0,
                  unknownUsageCount: 1,
                },
              ],
            },
          }),
          { status: 200 },
        ),
    });

    await expect(client.getRunContextUsage(runId)).resolves.toMatchObject({
      promptCache: {
        status: "UNREPORTED",
        totalRequestCount: 1,
        totalInputTokens: 100,
        totalOutputTokens: 2,
      },
    });
  });

  it("uses typed HTTP methods and validates the response contract", async () => {
    const session = makeSession();
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify(session), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.createSession({})).resolves.toEqual(session);
    expect(requests[0]?.url).toBe("http://daemon.test/api/v1/sessions");
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(await requests[0]?.json()).toEqual({});
  });

  it("parses split UTF-8 SSE frames, keeps ephemeral events cursorless, and rejects bad ids", async () => {
    const runId = createRunId();
    const durable = makeEvent(runId, 7, "DURABLE");
    const ephemeral = makeEvent(runId, 8, "EPHEMERAL");
    const text = [
      `event: ${durable.type}\r\nid: 7\r\ndata: ${JSON.stringify(durable)}\r\n\r\n`,
      `event: ${ephemeral.type}\r\ndata: ${JSON.stringify(ephemeral)}\r\n\r\n`,
    ].join("");
    const bytes = new TextEncoder().encode(text);
    const client = new CaelushClient({
      baseUrl: "http://daemon.test/",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 11));
              controller.enqueue(bytes.slice(11));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });

    await expect(
      (async () => {
        const events = [];
        for await (const event of client.watchRunEvents(runId, { afterSequence: 6 })) {
          events.push(event);
        }
        return events;
      })(),
    ).resolves.toEqual([durable, ephemeral]);

    const badId = `event: ${durable.type}\nid: 8\ndata: ${JSON.stringify(durable)}\n\n`;
    const badClient = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () => new Response(badId, { status: 200 }),
    });
    await expect(
      (async () => {
        for await (const event of badClient.watchRunEvents(runId)) {
          // The parser must fail before yielding an invalid event.
          void event;
        }
      })(),
    ).rejects.toBeInstanceOf(CaelushClientProtocolError);
  });

  it("normalizes the base URL, sends JSON headers, forwards AbortSignal, and parses compatibility", async () => {
    const signal = new AbortController().signal;
    const requests: Request[] = [];
    let receivedSignal: AbortSignal | null | undefined;
    const info = {
      apiVersion: "v1",
      protocolVersion: 1,
      daemonVersion: "0.1.0",
      capabilities: {
        runExecution: true,
        runRecovery: true,
        cancellation: true,
        approvals: true,
        sseReplay: true,
      },
      runtimeKinds: ["local"],
      configuredProviders: [],
      defaultRunConfiguration: {
        runtime: { id: "local", kind: "local" },
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
        limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
      },
    };
    const client = new CaelushClient({
      baseUrl: "http://daemon.test/root",
      fetch: async (input, init) => {
        receivedSignal = init?.signal;
        requests.push(new Request(input, init));
        return new Response(JSON.stringify(info), { status: 200 });
      },
    });

    await expect(client.getInfo({ signal })).resolves.toEqual(info);
    expect(requests[0]?.url).toBe("http://daemon.test/root/api/v1/info");
    expect(requests[0]?.headers.get("accept")).toBe("application/json");
    expect(receivedSignal).toBe(signal);

    const incompatible = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(JSON.stringify({ ...info, protocolVersion: 99 }), { status: 200 }),
    });
    await expect(incompatible.getInfo()).rejects.toBeInstanceOf(CaelushProtocolCompatibilityError);
  });

  it("maps safe API errors and rejects malformed error envelopes without dumping the body", async () => {
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "MODEL_PROVIDER_UNAVAILABLE",
              message: "The requested model provider or model is unavailable.",
              requestId: "req_test",
            },
          }),
          { status: 409 },
        ),
    });
    await expect(client.getHealth()).rejects.toMatchObject({
      status: 409,
      statusCode: 409,
      code: "MODEL_PROVIDER_UNAVAILABLE",
      requestId: "req_test",
    } satisfies Partial<CaelushClientHttpError>);

    const secret = "super-secret-response-body";
    const malformed = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () => new Response(`${secret.repeat(10)}<html>`, { status: 500 }),
    });
    const error = await malformed.getHealth().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CaelushClientHttpError);
    expect(String((error as Error).message)).not.toContain(secret);
  });

  it("cancels an active SSE reader when the caller aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        );
      },
    });
    const stream = client.watchRunEvents(createRunId(), { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    expect(cancelled).toBe(true);
  });

  it("calls onOpen once after a successful response and reader creation", async () => {
    let opens = 0;
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    for await (const _event of client.watchRunEvents(createRunId(), {
      onOpen: () => (opens += 1),
    })) {
      void _event;
    }
    expect(opens).toBe(1);
  });

  it("does not call onOpen for HTTP, fetch, body, or pre-open abort failures", async () => {
    const clients = [
      new CaelushClient({
        baseUrl: "http://daemon.test",
        fetch: async () => new Response("unavailable", { status: 503 }),
      }),
      new CaelushClient({
        baseUrl: "http://daemon.test",
        fetch: async () => {
          throw new Error("fetch failed");
        },
      }),
      new CaelushClient({
        baseUrl: "http://daemon.test",
        fetch: async () => new Response(null, { status: 200 }),
      }),
    ];

    for (const client of clients) {
      let opens = 0;
      const iterator = client.watchRunEvents(createRunId(), { onOpen: () => (opens += 1) });
      await expect(iterator[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(Error);
      expect(opens).toBe(0);
    }

    const abortController = new AbortController();
    abortController.abort();
    let opens = 0;
    const aborted = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () => new Response(new ReadableStream<Uint8Array>(), { status: 200 }),
    });
    const events = aborted.watchRunEvents(createRunId(), {
      signal: abortController.signal,
      onOpen: () => (opens += 1),
    });
    await expect(events[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    expect(opens).toBe(0);
  });

  it("does not create an unhandled rejection when reader cancellation fails", async () => {
    const controller = new AbortController();
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              return Promise.reject(new Error("reader cancellation failed"));
            },
          }),
          { status: 200 },
        ),
    });
    const stream = client.watchRunEvents(createRunId(), { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
  });
});

describe("CaelushClient workspace security preparation", () => {
  const PREPARE_SUFFIX = "/security/prepare";

  function capabilitiesPayload(workspaceId: string, prepared: boolean) {
    return {
      schemaVersion: 1,
      workspaceId,
      presets: [
        { id: "VIEW_ONLY", version: 1, status: "AVAILABLE" },
        prepared
          ? { id: "WORKSPACE_WRITE", version: 1, status: "AVAILABLE" }
          : {
              id: "WORKSPACE_WRITE",
              version: 1,
              status: "PREPARATION_REQUIRED",
              reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
            },
        { id: "FULL_ACCESS", version: 1, status: "AVAILABLE" },
      ],
      preparation: prepared
        ? { supported: true, status: "READY" }
        : { supported: true, status: "REQUIRED", reasonCode: "WORKSPACE_PREPARATION_REQUIRED" },
    };
  }

  it("drives the prepare-then-reload contract the permission selector depends on", async () => {
    const workspaceId = createWorkspaceId();
    const requests: Request[] = [];
    let prepared = false;
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith(PREPARE_SUFFIX)) {
          prepared = true;
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              workspaceId,
              preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
              status: "READY",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(capabilitiesPayload(workspaceId, prepared)), {
          status: 200,
        });
      },
    });

    const before = await client.getWorkspaceSecurityCapabilities(workspaceId);
    expect(before.preparation).toMatchObject({ supported: true, status: "REQUIRED" });
    expect(before.presets.find((preset) => preset.id === "WORKSPACE_WRITE")).toMatchObject({
      status: "PREPARATION_REQUIRED",
      reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
    });

    const preparation = await client.prepareWorkspaceSecurity(workspaceId, {
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });
    expect(preparation).toMatchObject({
      workspaceId,
      preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      status: "READY",
    });

    // The reload is the whole point: selection must not be re-derived from a stale capability read.
    const after = await client.getWorkspaceSecurityCapabilities(workspaceId);
    expect(after.preparation).toMatchObject({ supported: true, status: "READY" });
    expect(after.presets.find((preset) => preset.id === "WORKSPACE_WRITE")?.status).toBe(
      "AVAILABLE",
    );

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET http://daemon.test/api/v1/workspaces/${workspaceId}/security/capabilities`,
      `POST http://daemon.test/api/v1/workspaces/${workspaceId}/security/prepare`,
      `GET http://daemon.test/api/v1/workspaces/${workspaceId}/security/capabilities`,
    ]);
  });

  it("surfaces a stale prepare verdict as data and an unknown workspace as an HTTP error", async () => {
    const workspaceId = createWorkspaceId();
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith(PREPARE_SUFFIX)) {
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              workspaceId,
              preset: { id: "WORKSPACE_WRITE", expectedVersion: 2 },
              status: "FAILED",
              reasonCode: "PRESET_VERSION_MISMATCH",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            error: {
              code: "NOT_FOUND",
              message: "Requested resource was not found.",
              requestId: "1",
            },
          }),
          { status: 404 },
        );
      },
    });

    // A refused preparation is a normal verdict the caller must render, never a thrown exception.
    await expect(
      client.prepareWorkspaceSecurity(workspaceId, { id: "WORKSPACE_WRITE", expectedVersion: 2 }),
    ).resolves.toMatchObject({ status: "FAILED", reasonCode: "PRESET_VERSION_MISMATCH" });

    await expect(client.getWorkspaceSecurityCapabilities(workspaceId)).rejects.toBeInstanceOf(
      CaelushClientHttpError,
    );
  });
});
