import { createHash, randomUUID } from "node:crypto";
import { request } from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import { open, rename, rm, statfs, lstat } from "node:fs/promises";
import type { VerifiedUpdatePolicy } from "../../shared/signed-update-policy.mjs";
import type { UpdateTrust } from "../cloud/update-policy.js";
import { DesktopUpdateError } from "./error.js";
import { UpdateStateStore } from "./state-store.js";

const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export function validateReleaseUrl(source: string, trust: UpdateTrust): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw rejected();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    !trust.allowedReleaseHosts.includes(url.hostname) ||
    (url.port && url.port !== "443" && !trust.internalTestLoopback)
  )
    throw rejected();
  return url;
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b! >= 16 && b! <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 192 && [0, 2].includes(b!)) &&
      !(a === 198 && [18, 19, 51].includes(b!)) &&
      !(a === 203 && b === 0) &&
      !(a === 100 && b! >= 64 && b! <= 127) &&
      a! < 224
    );
  }
  // IPv6 global-unicast only. IPv4 mapped/private/special addresses are rejected.
  return (
    isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address)
  );
}
function rejected() {
  return new DesktopUpdateError(
    "UPDATE_URL_REJECTED",
    "The update artifact source is outside the trusted HTTPS release policy.",
  );
}
export async function downloadInstaller(
  policy: VerifiedUpdatePolicy,
  store: UpdateStateStore,
  trust: UpdateTrust,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  limits = { requestMs: 20000, totalMs: 15 * 60 * 1000, redirects: 4 },
): Promise<string> {
  const expected = policy.payload.release;
  if (expected.artifactSize > MAX_ARTIFACT_BYTES)
    throw new DesktopUpdateError("UPDATE_TOO_LARGE", "The installer exceeds the permitted size.");
  await store.assertDirectory();
  const disk = await statfs(store.root);
  if (disk.bavail * disk.bsize < expected.artifactSize + 64 * 1024 * 1024)
    throw new DesktopUpdateError(
      "UPDATE_DISK_FULL",
      "There is not enough space to stage this update.",
    );
  const id = randomUUID();
  const part = store.file(`${id}.part`);
  const verified = store.file(`${id}.exe`);
  const handle = await open(part, "wx", 0o600);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, limits.totalMs);
  let received = 0;
  const hash = createHash("sha512");
  try {
    await store.permissions.secureFile(part);
    await store.assertFile(`${id}.part`);
    let url = validateReleaseUrl(expected.artifactUrl, trust);
    for (let redirects = 0; ; redirects++) {
      const res = await getArtifact(url, trust, controller.signal, limits.requestMs);
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.destroy();
        if (redirects >= limits.redirects || !res.headers.location) throw rejected();
        url = validateReleaseUrl(new URL(res.headers.location, url).href, trust);
        continue;
      }
      validateReleaseUrl(url.href, trust);
      if (
        res.statusCode !== 200 ||
        (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
      ) {
        res.destroy();
        throw new DesktopUpdateError(
          "UPDATE_DOWNLOAD_HTTP",
          "The release server did not provide a complete installer.",
        );
      }
      const declared = res.headers["content-length"];
      if (
        declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) !== expected.artifactSize)
      ) {
        res.destroy();
        throw integrity();
      }
      for await (const chunk of res) {
        if (controller.signal.aborted)
          throw new DesktopUpdateError(
            "UPDATE_CANCELLED",
            "The download was cancelled or timed out.",
          );
        const bytes = Buffer.from(chunk as Uint8Array);
        received += bytes.length;
        if (received > expected.artifactSize) {
          res.destroy();
          throw integrity();
        }
        hash.update(bytes);
        await handle.writeFile(bytes);
        onProgress(received);
      }
      if (
        !res.complete ||
        received !== expected.artifactSize ||
        hash.digest("hex") !== expected.sha512
      )
        throw integrity();
      break;
    }
    await handle.sync();
    await handle.close();
    await store.assertFile(`${id}.part`);
    await rename(part, verified);
    await store.assertFile(`${id}.exe`);
    return `${id}.exe`;
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(part, { force: true });
    await rm(verified, { force: true });
    if (controller.signal.aborted)
      throw new DesktopUpdateError(
        signal.aborted ? "UPDATE_CANCELLED" : "UPDATE_DOWNLOAD_TIMEOUT",
        signal.aborted ? "The update download was cancelled." : "The update download timed out.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
function getArtifact(url: URL, trust: UpdateTrust, signal: AbortSignal, timeoutMs: number) {
  return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        agent: false,
        headers: { "accept-encoding": "identity" },
        ...(trust.internalTestCa ? { ca: trust.internalTestCa } : {}),
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true }, (err, addresses) => {
            if (err) {
              callback(err, "", 4);
              return;
            }
            const allowed = addresses.filter(
              (a) =>
                isPublicAddress(a.address) ||
                (trust.internalTestLoopback &&
                  hostname === "localhost" &&
                  ["127.0.0.1", "::1"].includes(a.address)),
            );
            if (allowed.length !== addresses.length || !allowed.length) {
              callback(rejected(), "", 4);
              return;
            }
            if (options.all) callback(null, allowed);
            else callback(null, allowed[0]!.address, allowed[0]!.family);
          });
        },
      },
      resolve,
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(
        new DesktopUpdateError("UPDATE_DOWNLOAD_TIMEOUT", "The update download stalled."),
      ),
    );
    req.once("error", reject);
    req.end();
  });
}
export async function verifyInstaller(
  policy: VerifiedUpdatePolicy,
  store: UpdateStateStore,
  name: string,
) {
  await store.assertFile(name);
  const file = await open(store.file(name), "r");
  try {
    const before = await file.stat();
    const hash = createHash("sha512");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > policy.payload.release.artifactSize) throw integrity();
      hash.update(chunk);
    }
    const after = await lstat(store.file(name));
    if (
      bytes !== policy.payload.release.artifactSize ||
      hash.digest("hex") !== policy.payload.release.sha512 ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs
    )
      throw integrity();
    await store.assertFile(name);
  } finally {
    await file.close();
  }
}
function integrity() {
  return new DesktopUpdateError(
    "UPDATE_INTEGRITY_FAILED",
    "The installer size or SHA-512 does not match the signed release.",
  );
}
