import assert from "node:assert/strict";
import { createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";

export const D6_TEST_EMAIL = "d6-internal@example.invalid";
export const D6_TEST_PASSWORD = "d6-internal-fixture-password";
export const D6_PROVIDER_ID = "deepseek";
export const D6_MODEL_ID = "deepseek-reasoner";
export const D6_PROVIDER_API_KEY = "d6-scripted-provider-fixture-key";
export const D6_PROVIDER_RESPONSE = "The installed D6 Agent fixture run completed.";
const D6_NATIVE_REPLAY_FIXTURE = "caelush-d6-controlled-private-native-replay";

export async function startInternalCloudFixture(identity, updateFixture) {
  assert.ok(identity && Number.isInteger(identity.cloudPort));
  const privateKey = createPrivateKey(await readFile(identity.privateKeyPath));
  const accounts = new Map();
  const refreshTokens = new Map();
  const accessTokens = new Map();
  const server = createServer((request, response) => {
    void handleCloudRequest(request, response).catch(() => {
      if (!response.headersSent) {
        cloudError(response, 500, "INTERNAL_ERROR", "The internal Cloud fixture failed.");
      } else response.end();
    });
  });

  async function handleCloudRequest(request, response) {
    if (
      updateFixture &&
      new URL(request.url, "http://127.0.0.1").pathname === "/v1/desktop/update-policy"
    ) {
      const result = updateFixture.getPolicy(request);
      return json(response, result.status, result.body);
    }
    const body = await readJsonBody(request);
    if (request.method === "POST" && request.url === "/v1/auth/login") {
      if (
        body.email !== D6_TEST_EMAIL ||
        body.password !== D6_TEST_PASSWORD ||
        typeof body.device?.publicKey !== "string"
      ) {
        return cloudError(
          response,
          401,
          "AUTH_INVALID_CREDENTIALS",
          "The test login credentials are invalid.",
        );
      }
      let account = accounts.get(D6_TEST_EMAIL);
      if (account === undefined) {
        account = {
          userId: randomUUID(),
          deviceId: randomUUID(),
          sessionId: randomUUID(),
          createdAt: new Date().toISOString(),
          deviceCreatedAt: new Date().toISOString(),
          deviceLabel: String(body.device.label ?? "D6 internal fixture").slice(0, 80),
        };
        accounts.set(D6_TEST_EMAIL, account);
      }
      return json(
        response,
        200,
        createAuthResult(account, identity.keyId, privateKey, refreshTokens, accessTokens),
      );
    }
    if (request.method === "POST" && request.url === "/v1/auth/refresh") {
      const account = refreshTokens.get(body.refreshToken);
      if (account === undefined) {
        return cloudError(
          response,
          401,
          "AUTH_TOKEN_INVALID",
          "The test session token is invalid.",
        );
      }
      refreshTokens.delete(body.refreshToken);
      return json(
        response,
        200,
        createAuthResult(account, identity.keyId, privateKey, refreshTokens, accessTokens),
      );
    }
    if (request.method === "POST" && request.url === "/v1/auth/logout") {
      const token = String(request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
      const refreshToken = accessTokens.get(token);
      if (refreshToken !== undefined) refreshTokens.delete(refreshToken);
      accessTokens.delete(token);
      return json(response, 200, { requestId: randomUUID(), status: "SUCCEEDED" });
    }
    return cloudError(
      response,
      404,
      "REQUEST_INVALID",
      "The internal Cloud fixture endpoint is unavailable.",
    );
  }

  server.listen(identity.cloudPort, "127.0.0.1");
  await once(server, "listening");
  return Object.freeze({
    origin: `http://127.0.0.1:${identity.cloudPort}`,
    close: () => closeServer(server),
  });
}

export async function startD6ProviderFixture() {
  const requests = [];
  let queuedTool = null;
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests, () => {
      const tool = queuedTool;
      queuedTool = null;
      return tool;
    }).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture failed" } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return Object.freeze({
    providerId: D6_PROVIDER_ID,
    modelId: D6_MODEL_ID,
    apiKey: D6_PROVIDER_API_KEY,
    origin: `http://127.0.0.1:${address.port}/v1`,
    requests,
    queueTool(command) {
      assert.equal(queuedTool, null);
      assert.equal(typeof command, "string");
      queuedTool = { cmd: command, yield_time_ms: 30000 };
    },
    close: () => closeServer(server),
  });
}

function createAuthResult(account, keyId, signingKey, refreshTokens, accessTokens) {
  const now = new Date();
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  refreshTokens.set(refreshToken, account);
  accessTokens.set(accessToken, refreshToken);
  const payload = {
    schemaVersion: 1,
    grantId: randomUUID(),
    userId: account.userId,
    deviceId: account.deviceId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
    entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
    keyId,
  };
  return {
    requestId: randomUUID(),
    sessionId: account.sessionId,
    account: {
      userId: account.userId,
      email: D6_TEST_EMAIL,
      emailVerified: true,
      entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
      createdAt: account.createdAt,
    },
    device: {
      deviceId: account.deviceId,
      label: account.deviceLabel,
      createdAt: account.deviceCreatedAt,
      lastSeenAt: now.toISOString(),
      revokedAt: null,
      current: true,
    },
    tokens: {
      tokenType: "Bearer",
      accessToken,
      accessExpiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      refreshToken,
      refreshExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      refreshAbsoluteExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60_000).toISOString(),
    },
    offlineGrant: {
      envelopeVersion: 1,
      payload,
      signature: sign(null, Buffer.from(canonicalize(payload), "utf8"), signingKey).toString(
        "base64url",
      ),
    },
  };
}

async function handleProviderRequest(request, response, requests, takeTool = () => null) {
  if (request.headers.authorization !== `Bearer ${D6_PROVIDER_API_KEY}`) {
    return json(response, 401, { error: { message: "fixture authentication failed" } });
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    return json(response, 200, {
      data: [{ id: D6_MODEL_ID, object: "model", owned_by: "d6-fixture" }],
    });
  }
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const body = await readJsonBody(request);
    requests.push("CHAT_COMPLETION");
    const tool = takeTool();
    if (
      Array.isArray(body.messages) &&
      body.messages.some(
        (message) =>
          message.role === "assistant" && message.reasoning_content === D6_NATIVE_REPLAY_FIXTURE,
      )
    )
      requests.push("NATIVE_REPLAY_RESTORED");
    const chunk = (delta, finishReason = null) =>
      `data: ${JSON.stringify({
        id: "caelush-d6-scripted-provider-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: D6_MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.end(
      tool
        ? `${chunk({ role: "assistant", reasoning_content: D6_NATIVE_REPLAY_FIXTURE })}${chunk({ tool_calls: [{ index: 0, id: "d72_held_effect", type: "function", function: { name: "exec_command", arguments: JSON.stringify(tool) } }] })}${chunk({}, "tool_calls")}data: [DONE]\n\n`
        : `${chunk({ role: "assistant", reasoning_content: D6_NATIVE_REPLAY_FIXTURE })}${chunk({ content: D6_PROVIDER_RESPONSE })}${chunk({}, "stop")}data: [DONE]\n\n`,
    );
    return;
  }
  return json(response, 404, { error: { message: "fixture route not found" } });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 65_536) throw new Error("fixture request too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function cloudError(response, statusCode, code, message) {
  return json(response, statusCode, {
    error: { code, message, retryable: false, requestId: randomUUID() },
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
