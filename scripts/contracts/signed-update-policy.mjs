import { createHash, createPublicKey, verify } from "node:crypto";
import { compareSemVer, getSemVerPrerelease, isValidSemVer } from "./semver.mjs";

const POLICY_SCHEMA_VERSION = 1;
const ENVELOPE_VERSION = 1;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const CHANNELS = new Set(["dev", "beta", "stable"]);
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const POLICY_FIELDS = [
  "schemaVersion",
  "product",
  "platform",
  "arch",
  "channel",
  "currentVersion",
  "latestVersion",
  "minimumSupportedVersion",
  "mandatory",
  "graceDeadline",
  "revision",
  "release",
  "issuedAt",
  "expiresAt",
  "keyId",
];
const RELEASE_FIELDS = ["version", "artifactUrl", "artifactSize", "sha512", "releaseNotes"];

export class PolicyContractError extends Error {
  /** @param {string} code @param {string} safeMessage */
  constructor(code, safeMessage) {
    super(safeMessage);
    this.name = "PolicyContractError";
    this.code = code;
  }
}

/**
 * Canonicalize the JSON value subset used by the signed policy contract using RFC 8785 JCS rules.
 * Policy numbers are restricted to safe integers; floats, -0, and unsafe integers are rejected.
 * @param {unknown} value
 */
export function canonicalizePolicyJson(value) {
  return canonicalize(value, new Set(), 0);
}

/**
 * Parse JSON while detecting duplicate decoded object keys before they can be collapsed by JSON.parse.
 * @param {string} source
 */
export function parsePolicyJson(source) {
  if (typeof source !== "string") fail("POLICY_JSON_INVALID", "Policy JSON input must be text.");
  if (Buffer.byteLength(source, "utf8") > MAX_JSON_BYTES) {
    fail("POLICY_JSON_TOO_LARGE", "Policy JSON input exceeds the permitted size.");
  }
  let position = 0;

  const whitespace = () => {
    while (position < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[position]))
      position += 1;
  };

  const parseString = () => {
    if (source[position] !== '"')
      fail("POLICY_JSON_INVALID", "Policy JSON contains an invalid string.");
    const start = position;
    position += 1;
    while (position < source.length) {
      const character = source[position];
      if (character === '"') {
        position += 1;
        let parsed;
        try {
          parsed = JSON.parse(source.slice(start, position));
        } catch {
          fail("POLICY_JSON_INVALID", "Policy JSON contains an invalid string.");
        }
        assertWellFormedUnicode(parsed);
        return parsed;
      }
      if (character === "\\") {
        position += 1;
        if (position >= source.length) break;
      } else if (character.charCodeAt(0) <= 0x1f) {
        fail("POLICY_JSON_INVALID", "Policy JSON contains an unescaped control character.");
      }
      position += 1;
    }
    fail("POLICY_JSON_INVALID", "Policy JSON contains an unterminated string.");
  };

  const parseValue = (depth) => {
    if (depth > MAX_JSON_DEPTH)
      fail("POLICY_JSON_TOO_DEEP", "Policy JSON exceeds the permitted nesting depth.");
    whitespace();
    const character = source[position];
    if (character === '"') return parseString();
    if (character === "{") {
      position += 1;
      whitespace();
      const value = Object.create(null);
      const keys = new Set();
      if (source[position] === "}") {
        position += 1;
        return value;
      }
      while (position < source.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key))
          fail("POLICY_JSON_DUPLICATE_KEY", "Policy JSON contains a duplicate object key.");
        keys.add(key);
        whitespace();
        if (source[position] !== ":")
          fail("POLICY_JSON_INVALID", "Policy JSON object is malformed.");
        position += 1;
        value[key] = parseValue(depth + 1);
        whitespace();
        if (source[position] === "}") {
          position += 1;
          return value;
        }
        if (source[position] !== ",")
          fail("POLICY_JSON_INVALID", "Policy JSON object is malformed.");
        position += 1;
      }
      fail("POLICY_JSON_INVALID", "Policy JSON object is unterminated.");
    }
    if (character === "[") {
      position += 1;
      whitespace();
      const value = [];
      if (source[position] === "]") {
        position += 1;
        return value;
      }
      while (position < source.length) {
        value.push(parseValue(depth + 1));
        whitespace();
        if (source[position] === "]") {
          position += 1;
          return value;
        }
        if (source[position] !== ",")
          fail("POLICY_JSON_INVALID", "Policy JSON array is malformed.");
        position += 1;
      }
      fail("POLICY_JSON_INVALID", "Policy JSON array is unterminated.");
    }
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.startsWith(token, position)) {
        position += token.length;
        return value;
      }
    }
    const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(position));
    if (numberMatch !== null) {
      position += numberMatch[0].length;
      if (/[.eE]/.test(numberMatch[0])) {
        fail("POLICY_NUMBER_UNSUPPORTED", "Policy JSON numbers must use the integer form.");
      }
      let number;
      try {
        number = JSON.parse(numberMatch[0]);
      } catch {
        fail("POLICY_JSON_INVALID", "Policy JSON contains an invalid number.");
      }
      if (!Number.isSafeInteger(number) || Object.is(number, -0)) {
        fail(
          "POLICY_NUMBER_UNSUPPORTED",
          "Policy JSON numbers must be safe integers and cannot be negative zero.",
        );
      }
      return number;
    }
    fail("POLICY_JSON_INVALID", "Policy JSON contains an invalid value.");
  };

  const result = parseValue(0);
  whitespace();
  if (position !== source.length) fail("POLICY_JSON_INVALID", "Policy JSON has trailing content.");
  canonicalizePolicyJson(result);
  return result;
}

/** @param {unknown} payload */
export function validateUpdatePolicyPayload(payload) {
  assertExactKeys(payload, POLICY_FIELDS, "POLICY_PAYLOAD_INVALID");
  if (payload.schemaVersion !== POLICY_SCHEMA_VERSION || payload.product !== "caelush") {
    fail("POLICY_PAYLOAD_INVALID", "Policy schema version or product identifier is invalid.");
  }
  if (payload.platform !== "windows" || payload.arch !== "x64") {
    fail("POLICY_PLATFORM_INVALID", "Policy platform is unsupported.");
  }
  if (!CHANNELS.has(payload.channel))
    fail("POLICY_CHANNEL_INVALID", "Policy release channel is invalid.");
  for (const [field, version] of [
    ["currentVersion", payload.currentVersion],
    ["latestVersion", payload.latestVersion],
    ["minimumSupportedVersion", payload.minimumSupportedVersion],
  ]) {
    if (!isValidSemVer(version))
      fail("POLICY_VERSION_INVALID", `Policy ${field} is not valid SemVer 2.0.0.`);
  }
  const currentVsLatest = compareSemVer(payload.currentVersion, payload.latestVersion);
  if (currentVsLatest > 0)
    fail(
      "POLICY_DOWNGRADE_REJECTED",
      "Policy cannot select an older release than the current version.",
    );
  if (compareSemVer(payload.minimumSupportedVersion, payload.latestVersion) > 0) {
    fail(
      "POLICY_VERSION_RANGE_INVALID",
      "Minimum supported version cannot exceed the latest release.",
    );
  }
  if (payload.channel === "stable" && getSemVerPrerelease(payload.latestVersion).length > 0) {
    fail("POLICY_CHANNEL_VERSION_MISMATCH", "Stable policy cannot select a prerelease version.");
  }
  if (payload.channel === "beta" && getSemVerPrerelease(payload.latestVersion).length > 0) {
    const prerelease = getSemVerPrerelease(payload.latestVersion);
    if (prerelease[0] !== "beta" && prerelease[0] !== "rc") {
      fail(
        "POLICY_CHANNEL_VERSION_MISMATCH",
        "Beta policy accepts only beta or release-candidate prerelease versions.",
      );
    }
  }
  if (typeof payload.mandatory !== "boolean")
    fail("POLICY_PAYLOAD_INVALID", "Policy mandatory must be a boolean.");
  if (
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 1 ||
    Object.is(payload.revision, -0)
  ) {
    fail("POLICY_REVISION_INVALID", "Policy revision must be a positive safe integer.");
  }
  validateRelease(payload.release, payload.latestVersion);
  const issuedAt = parseRfc3339Utc(payload.issuedAt, "issuedAt");
  const expiresAt = parseRfc3339Utc(payload.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt)
    fail("POLICY_TIME_RANGE_INVALID", "Policy expiry must be after issue time.");
  if (payload.graceDeadline !== null) {
    const graceDeadline = parseRfc3339Utc(payload.graceDeadline, "graceDeadline");
    if (graceDeadline < issuedAt || graceDeadline > expiresAt) {
      fail(
        "POLICY_TIME_RANGE_INVALID",
        "Policy grace deadline must fall inside the signed policy validity window.",
      );
    }
  }
  if (!payload.mandatory && payload.graceDeadline !== null) {
    fail(
      "POLICY_TIME_RANGE_INVALID",
      "A non-mandatory policy cannot carry a mandatory grace deadline.",
    );
  }
  if (typeof payload.keyId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(payload.keyId)) {
    fail("POLICY_KEY_ID_INVALID", "Policy keyId is missing or invalid.");
  }
  return payload;
}

/**
 * Verify an Ed25519 SignedEnvelope after strict parsing, JCS normalization, URL allowlisting,
 * validity checks, and monotonic revision checks. No network access or persistence is performed.
 * @param {string | unknown} input raw JSON text or parsed envelope
 * @param {{ publicKeys: Record<string, string | Buffer> | Map<string, string | Buffer>, allowedReleaseHosts: readonly string[], now?: number, acceptedPolicy?: { revision: number, digestSha256: string } }} options
 */
export function verifySignedUpdatePolicy(input, options) {
  if (typeof input !== "string") {
    fail(
      "POLICY_JSON_TEXT_REQUIRED",
      "Signed policy verification requires the original JSON text.",
    );
  }
  if (options === null || typeof options !== "object" || options.publicKeys === undefined) {
    fail("POLICY_KEYRING_REQUIRED", "A trusted signing keyring is required.");
  }
  const envelope = parsePolicyJson(input);
  assertExactKeys(envelope, ["envelopeVersion", "payload", "signature"], "POLICY_ENVELOPE_INVALID");
  if (envelope.envelopeVersion !== ENVELOPE_VERSION) {
    fail("POLICY_ENVELOPE_INVALID", "Policy envelope version is unsupported.");
  }
  const payload = validateUpdatePolicyPayload(envelope.payload);
  const allowedHosts = options?.allowedReleaseHosts;
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    fail("POLICY_HOST_ALLOWLIST_REQUIRED", "A trusted release hostname allowlist is required.");
  }
  validateArtifactHost(payload.release.artifactUrl, allowedHosts);

  const canonicalPayload = canonicalizePolicyJson(payload);
  const canonicalBytes = Buffer.from(canonicalPayload, "utf8");
  const digestSha256 = createHash("sha256").update(canonicalBytes).digest("hex");
  const signatureBytes = decodeSignature(envelope.signature);
  const keyValue =
    options.publicKeys instanceof Map
      ? options.publicKeys.get(payload.keyId)
      : options.publicKeys?.[payload.keyId];
  if (keyValue === undefined) fail("POLICY_KEY_ID_UNKNOWN", "Policy signing key is not trusted.");
  let publicKey;
  try {
    publicKey = createPublicKey(keyValue);
  } catch {
    fail("POLICY_PUBLIC_KEY_INVALID", "Policy signing key material is invalid.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("POLICY_PUBLIC_KEY_INVALID", "Policy signing key must use Ed25519.");
  }
  let signatureValid = false;
  try {
    signatureValid = verify(null, canonicalBytes, publicKey, signatureBytes);
  } catch {
    fail("POLICY_SIGNATURE_INVALID", "Policy signature verification failed.");
  }
  if (!signatureValid) {
    fail("POLICY_SIGNATURE_INVALID", "Policy signature verification failed.");
  }

  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    fail("POLICY_CLOCK_INVALID", "Policy verification time is invalid.");
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (now < issuedAt) fail("POLICY_NOT_YET_VALID", "Policy is not valid yet.");
  if (now >= expiresAt) fail("POLICY_EXPIRED", "Policy has expired.");

  const accepted = options.acceptedPolicy;
  if (accepted !== undefined) {
    if (!Number.isSafeInteger(accepted.revision) || accepted.revision < 1) {
      fail("POLICY_REVISION_STATE_INVALID", "Previously accepted policy revision is invalid.");
    }
    if (payload.revision < accepted.revision) {
      fail("POLICY_REVISION_ROLLBACK", "Policy revision is older than the last accepted revision.");
    }
    if (payload.revision === accepted.revision && digestSha256 !== accepted.digestSha256) {
      fail("POLICY_REVISION_CONFLICT", "Policy content changed without increasing its revision.");
    }
  }
  return Object.freeze({ payload, canonicalPayload, canonicalBytes, digestSha256 });
}

function validateRelease(release, latestVersion) {
  assertExactKeys(release, RELEASE_FIELDS, "POLICY_RELEASE_INVALID");
  if (release.version !== latestVersion || !isValidSemVer(release.version)) {
    fail("POLICY_RELEASE_VERSION_MISMATCH", "Release version must equal the signed latestVersion.");
  }
  if (
    !Number.isSafeInteger(release.artifactSize) ||
    release.artifactSize < 1 ||
    release.artifactSize > SAFE_INTEGER_MAX
  ) {
    fail("POLICY_ARTIFACT_INVALID", "Release artifact size must be a positive safe integer.");
  }
  if (typeof release.sha512 !== "string" || !/^[a-f0-9]{128}$/.test(release.sha512)) {
    fail("POLICY_ARTIFACT_INVALID", "Release artifact SHA-512 must be lowercase hexadecimal.");
  }
  if (typeof release.releaseNotes !== "string" || release.releaseNotes.length > 16_384) {
    fail("POLICY_ARTIFACT_INVALID", "Release notes are invalid or too large.");
  }
  if (typeof release.artifactUrl !== "string")
    fail("POLICY_ARTIFACT_INVALID", "Release artifact URL is invalid.");
  let url;
  try {
    url = new URL(release.artifactUrl);
  } catch {
    fail("POLICY_ARTIFACT_INVALID", "Release artifact URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    fail(
      "POLICY_ARTIFACT_INVALID",
      "Release artifact URL must be HTTPS and contain no credentials or fragment.",
    );
  }
}

function validateArtifactHost(artifactUrl, allowedHosts) {
  const normalized = new Set(allowedHosts.map((host) => String(host).toLowerCase()));
  const hostname = new URL(artifactUrl).hostname.toLowerCase();
  if (!normalized.has(hostname))
    fail("POLICY_ARTIFACT_HOST_NOT_ALLOWED", "Release artifact host is not allowlisted.");
}

function decodeSignature(signature) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    fail("POLICY_SIGNATURE_INVALID", "Policy signature encoding is invalid.");
  }
  const decoded = Buffer.from(signature, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== signature) {
    fail("POLICY_SIGNATURE_INVALID", "Policy signature encoding is invalid.");
  }
  return decoded;
}

function parseRfc3339Utc(value, field) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    fail("POLICY_TIME_INVALID", `Policy ${field} must be an RFC 3339 UTC timestamp ending in Z.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("POLICY_TIME_INVALID", `Policy ${field} is invalid.`);
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.slice(0, -1).split(/[.:]/).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    fail("POLICY_TIME_INVALID", `Policy ${field} is invalid.`);
  }
  return milliseconds;
}

function assertExactKeys(value, expectedKeys, code) {
  if (!isRecord(value)) fail(code, "Policy object has an invalid shape.");
  const expected = new Set(expectedKeys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    fail(code, "Policy object contains missing or unrecognized fields.");
  }
}

function canonicalize(value, ancestors, depth) {
  if (depth > MAX_JSON_DEPTH)
    fail("POLICY_JSON_TOO_DEEP", "Policy value exceeds the permitted nesting depth.");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail(
        "POLICY_NUMBER_UNSUPPORTED",
        "Policy numbers must be safe integers and cannot be negative zero.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail("POLICY_JSON_CYCLE", "Policy value cannot contain a cycle.");
    ancestors.add(value);
    const entries = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index))
        fail("POLICY_JSON_INVALID", "Policy arrays cannot be sparse.");
      entries.push(canonicalize(value[index], ancestors, depth + 1));
    }
    ancestors.delete(value);
    return `[${entries.join(",")}]`;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) fail("POLICY_JSON_CYCLE", "Policy value cannot contain a cycle.");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("POLICY_JSON_INVALID", "Policy objects must use a plain JSON object prototype.");
    }
    ancestors.add(value);
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        assertWellFormedUnicode(key);
        const fieldValue = value[key];
        if (
          fieldValue === undefined ||
          typeof fieldValue === "function" ||
          typeof fieldValue === "symbol" ||
          typeof fieldValue === "bigint"
        ) {
          fail("POLICY_JSON_INVALID", "Policy object contains a non-JSON value.");
        }
        return `${JSON.stringify(key)}:${canonicalize(fieldValue, ancestors, depth + 1)}`;
      });
    ancestors.delete(value);
    return `{${entries.join(",")}}`;
  }
  fail("POLICY_JSON_INVALID", "Policy value contains a non-JSON type.");
}

function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(
          "POLICY_UNICODE_INVALID",
          "Policy strings must contain valid Unicode scalar sequences.",
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("POLICY_UNICODE_INVALID", "Policy strings must contain valid Unicode scalar sequences.");
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, safeMessage) {
  throw new PolicyContractError(code, safeMessage);
}
