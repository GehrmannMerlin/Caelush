import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createControllableProviderServer } from "./support/controllable-provider-server.js";

describe("controllable Provider server request capture", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("retains the byte length and SHA-256 of the actual request body", async () => {
    const server = await createControllableProviderServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    close = server.close;
    const body = '{ "note": "café", "count": 13 }';

    const response = await fetch(`${server.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(204);

    const captured = await server.waitForRequest(0);
    expect(captured.rawBodyByteLength).toBe(Buffer.byteLength(body, "utf8"));
    expect(captured.rawBodySha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
  });
});
