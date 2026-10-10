import { describe, expect, it, vi } from "vitest";
import { DesktopLocalProxy } from "../../src/main/protocol/local-proxy.js";

const HOST_TOKEN = "A".repeat(43);

function rendererRequest(
  input: {
    readonly path?: string;
    readonly method?: string;
    readonly headers?: HeadersInit;
    readonly body?: string;
    readonly referrer?: string;
    readonly initiatorOrigin?: string;
    readonly signal?: AbortSignal;
  } = {},
): Request {
  const method = input.method ?? "GET";
  const source =
    input.body === undefined
      ? undefined
      : new Request("http://renderer.invalid/", { method, body: input.body }).body;
  return {
    url: `caelush-app://app${input.path ?? "/api/v1/health"}`,
    method,
    headers: new Headers(input.headers),
    body: source ?? null,
    signal: input.signal ?? new AbortController().signal,
    referrer: input.referrer ?? "caelush-app://app/agent/",
    initiatorOrigin: input.initiatorOrigin ?? "caelush-app://app",
  } as Request;
}

function createProxy(fetcher: typeof fetch, generationSignal = new AbortController().signal) {
  const release = vi.fn();
  const acquireLease = vi.fn((requestSignal: AbortSignal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    requestSignal.addEventListener("abort", abort, { once: true });
    generationSignal.addEventListener("abort", abort, { once: true });
    if (requestSignal.aborted || generationSignal.aborted) abort();
    return {
      baseUrl: "http://127.0.0.1:43219",
      hostToken: HOST_TOKEN,
      signal: controller.signal,
      release: () => {
        requestSignal.removeEventListener("abort", abort);
        generationSignal.removeEventListener("abort", abort);
        release();
      },
    };
  });
  return {
    proxy: new DesktopLocalProxy({ acquireLease, fetcher }),
    acquireLease,
    release,
  };
}

describe("Main-owned Desktop Daemon proxy", () => {
  it("denies unauthorized and non-Agent app requests before contacting the Daemon", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const denied = new DesktopLocalProxy({ acquireLease: () => null, fetcher });
    expect((await denied.handle(rendererRequest())).status).toBe(401);

    const available = createProxy(fetcher);
    expect(
      (await available.proxy.handle(rendererRequest({ referrer: "caelush-app://app/" }))).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(available.acquireLease).not.toHaveBeenCalled();
  });

  it("requires Electron's browser-controlled Agent origin and rejects the account origin", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const setup = createProxy(fetcher);
    const fromAccount = rendererRequest({
      initiatorOrigin: "caelush-login://app",
      referrer: "caelush-app://app/agent/",
      headers: { origin: "caelush-app://app" },
    });

    expect((await setup.proxy.handle(fromAccount)).status).toBe(403);
    expect(setup.acquireLease).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    const fromAgent = rendererRequest({ referrer: "" });
    expect((await setup.proxy.handle(fromAgent)).status).toBe(200);
    expect(setup.acquireLease).toHaveBeenCalledOnce();
  });

  it.each([
    "https://attacker.example/api/v1/health",
    "caelush-app://attacker/api/v1/health",
    "caelush-app://app/api/v1/%2e%2e/health",
    "caelush-app://app/api/v1/%25252e%25252e/health",
    "caelush-app://app/api/v1/runs/%2fetc/events",
    "caelush-app://app/api/v1/runs/%25252fetc/events",
    "caelush-app://app/api/v1x/health",
  ])("rejects unsafe proxy URL %s", async (source) => {
    const fetcher = vi.fn<typeof fetch>();
    const setup = createProxy(fetcher);
    const request = rendererRequest();
    Object.defineProperty(request, "url", { value: source });
    expect((await setup.proxy.handle(request)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(setup.acquireLease).not.toHaveBeenCalled();
  });

  it("rejects a Renderer Host Token and strips other identity credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const setup = createProxy(fetcher);
    const request = rendererRequest({
      headers: {
        authorization: "Bearer cloud-access-token",
        cookie: "session=private",
        "x-caelush-host-token": "renderer-token",
      },
    });
    expect((await setup.proxy.handle(request)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves method, query, safe headers, body, and Daemon status/error payload", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return new Response(JSON.stringify({ error: { code: "INVALID_EVENT_CURSOR" } }), {
        status: 400,
        headers: { "content-type": "application/json", connection: "keep-alive" },
      });
    });
    const setup = createProxy(fetcher);
    const request = rendererRequest({
      path: "/api/v1/runs/8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857/events?afterSequence=9",
      method: "POST",
      body: '{"cursor":true}',
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "last-event-id": "8",
        authorization: "Bearer cloud-access-token",
        cookie: "session=private",
      },
    });

    const response = await setup.proxy.handle(request);
    expect(receivedUrl).toBe(
      "http://127.0.0.1:43219/api/v1/runs/8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857/events?afterSequence=9",
    );
    expect(receivedInit?.method).toBe("POST");
    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("last-event-id")).toBe("8");
    expect(headers.get("x-caelush-host-token")).toBe(HOST_TOKEN);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(receivedInit?.body).toBeInstanceOf(Uint8Array);
    expect(await new Response(receivedInit?.body).text()).toBe('{"cursor":true}');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_EVENT_CURSOR" } });
    expect(response.headers.has("connection")).toBe(false);
    expect(setup.release).toHaveBeenCalledOnce();
  });

  it("caps buffered request bodies before forwarding them to the Daemon", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const release = vi.fn();
    const proxy = new DesktopLocalProxy({
      acquireLease: () => ({
        baseUrl: "http://127.0.0.1:43219",
        hostToken: HOST_TOKEN,
        signal: new AbortController().signal,
        release,
      }),
      fetcher,
      maxRequestBodyBytes: 4,
    });

    const response = await proxy.handle(
      rendererRequest({ method: "POST", body: "12345", headers: { "content-type": "text/plain" } }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("streams SSE chunks, forwards both cursors unchanged, and aborts on subscriber close", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("last-event-id")).toBe("6");
      expect(new URL(String(_input)).searchParams.get("afterSequence")).toBe("7");
      init?.signal?.addEventListener(
        "abort",
        () => {
          streamController?.error(new Error("upstream aborted"));
        },
        { once: true },
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode('id: 7\nevent: run.progress\ndata: {"n":7}\n\n'));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const setup = createProxy(fetcher);
    const subscriber = new AbortController();
    const request = rendererRequest({
      path: "/api/v1/runs/8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857/events?afterSequence=7",
      headers: { accept: "text/event-stream", "last-event-id": "6" },
      signal: subscriber.signal,
    });

    const response = await setup.proxy.handle(request);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("id: 7");
    subscriber.abort();
    await reader?.read().catch(() => undefined);
    expect(setup.release).toHaveBeenCalledOnce();
  });

  it("does not follow non-local Daemon redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://attacker.example/collect" },
        }),
    );
    const setup = createProxy(fetcher);
    const response = await setup.proxy.handle(rendererRequest());
    expect(response.status).toBe(302);
    expect(response.headers.has("location")).toBe(false);
  });
});
