import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign, randomUUID, createPrivateKey } from "node:crypto";
import { createServer } from "node:https";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { setInterval, clearInterval } from "node:timers";
import { once } from "node:events";
import { canonicalizePolicyJson } from "../src/shared/signed-update-policy.mjs";

/** Fixture secrets stay in an explicitly external scratch directory. Never imported by Main. */
export async function createLocalUpdateIdentity(root) {
  assert.ok(path.isAbsolute(root));
  const repository = path.resolve(import.meta.dirname, "../../..");
  assert.ok(!path.resolve(root).toLowerCase().startsWith(`${repository.toLowerCase()}${path.sep}`));
  await mkdir(root, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = `d72_test_${randomUUID()}`;
  const signingPath = path.join(root, "update-signing-private.pem");
  const tlsKey = path.join(root, "tls-private.pem");
  const tlsCert = path.join(root, "tls-public.pem");
  await writeFile(signingPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
    flag: "wx",
    mode: 0o600,
  });
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true });
  const openssl =
    process.env.CAELUSH_TEST_OPENSSL ??
    (process.platform === "win32" && git.status === 0
      ? path.resolve(git.stdout.trim(), "../../../usr/bin/openssl.exe")
      : "openssl");
  const result = spawnSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tlsKey,
      "-out",
      tlsCert,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(result.status, 0, "Could not generate the isolated HTTPS fixture identity.");
  return {
    root,
    keyId,
    signingPath,
    tlsKey,
    tlsCert,
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    rawPublicKey: publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url"),
    ca: await readFile(tlsCert, "utf8"),
  };
}
export async function startLocalUpdateFixture(
  identity,
  artifactPath,
  versions = { current: "0.1.0", latest: "0.1.1" },
) {
  const privateKey = createPrivateKey(await readFile(identity.signingPath));
  const metadata = await stat(artifactPath);
  const hash = createHash("sha512");
  for await (const bytes of createReadStream(artifactPath)) hash.update(bytes);
  const sha512 = hash.digest("hex");
  let mode = "good";
  let revision = 1;
  const server = createServer(
    { key: await readFile(identity.tlsKey), cert: identity.ca },
    (request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "https://untrusted.invalid/installer.exe" });
        response.end();
        return;
      }
      if (mode === "timeout") return;
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        ...(mode === "truncated" ? {} : { "content-length": metadata.size }),
      });
      if (mode === "truncated") {
        response.end("short");
        return;
      }
      if (mode === "slow") {
        const timer = setInterval(() => response.write(Buffer.alloc(1)), 50);
        response.on("close", () => clearInterval(timer));
        return;
      }
      const stream = createReadStream(artifactPath);
      stream.pipe(response);
      response.on("close", () => stream.destroy());
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  function policy(overrides = {}) {
    const payload = {
      schemaVersion: 1,
      product: "caelush",
      platform: "windows",
      arch: "x64",
      channel: "dev",
      currentVersion: versions.current,
      latestVersion: versions.latest,
      minimumSupportedVersion: versions.current,
      mandatory: false,
      graceDeadline: null,
      revision,
      release: {
        version: versions.latest,
        artifactUrl: `${origin}/${mode === "redirect" ? "redirect" : "installer.exe"}`,
        artifactSize: metadata.size,
        sha512,
        releaseNotes: "Isolated D7-2 real Windows upgrade fixture.",
      },
      issuedAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      keyId: identity.keyId,
      ...overrides,
    };
    return {
      requestId: randomUUID(),
      signedPolicy: {
        envelopeVersion: 1,
        payload,
        signature: sign(null, Buffer.from(canonicalizePolicyJson(payload)), privateKey).toString(
          "base64url",
        ),
      },
    };
  }
  // Cache immutable bytes per revision / requested version, just as the real Cloud registry does.
  let published = policy();
  return {
    origin,
    artifactSize: metadata.size,
    sha512,
    policy,
    publish(overrides = {}) {
      revision++;
      published = policy(overrides);
      return published;
    },
    setMode(value) {
      mode = value;
    },
    getPolicy(request) {
      const url = new URL(request.url, "http://127.0.0.1");
      const fields = ["platform", "arch", "channel", "currentVersion"];
      if (
        request.method !== "GET" ||
        [...url.searchParams].length !== 4 ||
        fields.some((k) => url.searchParams.getAll(k).length !== 1) ||
        url.searchParams.get("platform") !== "windows" ||
        url.searchParams.get("arch") !== "x64" ||
        url.searchParams.get("channel") !== "dev"
      )
        return {
          status: 400,
          body: {
            error: {
              requestId: randomUUID(),
              code: "UPDATE_POLICY_INVALID_REQUEST",
              message: "Invalid update request.",
              retryable: false,
            },
          },
        };
      if (url.searchParams.get("currentVersion") !== versions.current)
        return {
          status: 404,
          body: {
            error: {
              requestId: randomUUID(),
              code: "UPDATE_POLICY_NOT_AVAILABLE",
              message: "No policy for this version.",
              retryable: false,
            },
          },
        };
      return { status: 200, body: published };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
