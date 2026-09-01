import {
  AgentEventSchema,
  ClientAgentSessionSchema,
  createEventId,
  createRunId,
  createSessionId,
  createToolInvocationId,
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
  return AgentEventSchema.parse({
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
    await expect(
      aborted.watchRunEvents(createRunId(), {
        signal: abortController.signal,
        onOpen: () => (opens += 1),
      })[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({ done: true });
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
