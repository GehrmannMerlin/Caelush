import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedProviderHttpRequest {
  readonly index: number;
  readonly path: string;
  readonly method: string;
  readonly receivedAt: number;
  readonly body: Readonly<Record<string, unknown>>;
  closedBeforeResponseEnded: boolean;
}

export type ProviderHttpHandler = (
  request: CapturedProviderHttpRequest,
  response: ServerResponse,
) => void | Promise<void>;

/** A loopback-only wire fixture for real adapter/fetch behavior; it never calls an Internet host. */
export interface ControllableProviderServer {
  readonly endpoint: string;
  readonly requests: readonly CapturedProviderHttpRequest[];
  waitForRequest(index: number): Promise<CapturedProviderHttpRequest>;
  close(): Promise<void>;
}

export async function createControllableProviderServer(
  handler: ProviderHttpHandler,
): Promise<ControllableProviderServer> {
  const requests: CapturedProviderHttpRequest[] = [];
  const waiters: Array<{
    readonly index: number;
    readonly resolve: (request: CapturedProviderHttpRequest) => void;
  }> = [];
  const server: Server = createServer((incoming, response) => {
    void captureRequest(incoming)
      .then(({ path, method, body }) => {
        const captured: CapturedProviderHttpRequest = {
          index: requests.length,
          path,
          method,
          receivedAt: Date.now(),
          body,
          closedBeforeResponseEnded: false,
        };
        requests.push(captured);
        for (const waiter of [...waiters]) {
          if (waiter.index !== captured.index) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(captured);
        }
        response.on("close", () => {
          captured.closedBeforeResponseEnded = !response.writableEnded;
        });
        return handler(captured, response);
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        if (!response.writableEnded) response.end("fixture handler failed");
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("Controllable Provider server did not bind a TCP port.");
  }
  const port = (address as AddressInfo).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    waitForRequest(index) {
      const existing = requests[index];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ index, resolve }));
    },
    close: () => closeHttpServer(server),
  };
}

export function beginOpenAISse(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  response.flushHeaders();
}

export function writeOpenAIChunk(
  response: ServerResponse,
  input: {
    readonly model: string;
    readonly delta: Readonly<Record<string, unknown>>;
    readonly finishReason?: string | null;
  },
): void {
  response.write(
    `data: ${JSON.stringify({
      id: "caelush-loopback-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: input.model,
      choices: [{ index: 0, delta: input.delta, finish_reason: input.finishReason ?? null }],
    })}\n\n`,
  );
}

export function finishOpenAISse(response: ServerResponse): void {
  writeOpenAIChunk(response, { model: "stream-fixture-model", delta: {}, finishReason: "stop" });
  response.end("data: [DONE]\n\n");
}

export function sendOpenAIText(response: ServerResponse, text: string): void {
  beginOpenAISse(response);
  writeOpenAIChunk(response, { model: "stream-fixture-model", delta: { content: text } });
  finishOpenAISse(response);
}

export function sendRateLimit(response: ServerResponse, retryAfter: string): void {
  response.writeHead(429, {
    "content-type": "application/json",
    "retry-after": retryAfter,
  });
  response.end(JSON.stringify({ error: { message: "fixture rate limit", type: "rate_limit" } }));
}

async function captureRequest(incoming: IncomingMessage): Promise<{
  readonly path: string;
  readonly method: string;
  readonly body: Readonly<Record<string, unknown>>;
}> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown = {};
  if (text.length > 0) body = JSON.parse(text);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Provider fixture request body was not a JSON object.");
  }
  return {
    path: incoming.url ?? "/",
    method: incoming.method ?? "GET",
    body: body as Readonly<Record<string, unknown>>,
  };
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
