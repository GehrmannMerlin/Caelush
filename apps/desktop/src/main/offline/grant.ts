import {
  createPrivateKey,
  createPublicKey,
  sign as signSignature,
  type KeyObject,
  verify as verifySignature,
} from "node:crypto";

const MAX_JSON_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const OFFLINE_GRANT_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_ROLLBACK_MS = 5 * 60 * 1000;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ENTITLEMENT_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DEVICE_PROOF_DOMAIN = Buffer.from("caelush-offline-grant-device-proof-v1\0", "utf8");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class OfflineGrantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OfflineGrantError";
  }
}

export interface OfflineClockEvidence {
  readonly wallTime: Date;
  readonly lastTrustedServerTime: Date;
  readonly lastAcceptedTime: Date;
  readonly monotonicAnchor?: { readonly trustedTime: Date; readonly monotonicMs: number };
  readonly monotonicNowMs?: number;
}

export interface OfflineGrantVerificationInput {
  readonly trustedPublicKeys: Readonly<Record<string, Uint8Array>>;
  readonly userId: string;
  readonly deviceId: string;
  readonly devicePrivateKey: KeyObject;
  readonly challenge: Uint8Array;
  readonly proofSignature: string;
  readonly allowedEntitlements: ReadonlySet<string>;
  readonly clock: OfflineClockEvidence;
}

export interface OfflineGrantVerification {
  readonly grantId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly entitlements: readonly string[];
  readonly trustedNow: Date;
  readonly nextLastAcceptedTime: Date;
}

export function canonicalizeJcs(value: unknown): string {
  return canonicalize(value, new Set(), 0);
}

export function parseStrictJcsJson(source: string | Uint8Array): unknown {
  const text =
    typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new OfflineGrantError(
      "JSON_TOO_LARGE",
      "The signed JSON document exceeds its size limit.",
    );
  }
  let position = 0;
  const whitespace = () => {
    while (position < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[position] ?? "")) {
      position += 1;
    }
  };
  const parseString = (): string => {
    if (text[position] !== '"') invalidJson();
    const start = position;
    position += 1;
    while (position < text.length) {
      const character = text[position];
      if (character === '"') {
        position += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text.slice(start, position));
        } catch {
          invalidJson();
        }
        if (typeof parsed !== "string") invalidJson();
        assertUnicode(parsed);
        return parsed;
      }
      if (character === "\\") {
        position += 1;
        if (position >= text.length) break;
      } else if ((character?.charCodeAt(0) ?? 0) <= 0x1f) {
        invalidJson();
      }
      position += 1;
    }
    invalidJson();
  };
  const parseValue = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) {
      throw new OfflineGrantError(
        "JSON_TOO_DEEP",
        "The signed JSON document is too deeply nested.",
      );
    }
    whitespace();
    const character = text[position];
    if (character === '"') return parseString();
    if (character === "{") {
      position += 1;
      whitespace();
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (text[position] === "}") {
        position += 1;
        return output;
      }
      while (position < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) {
          throw new OfflineGrantError(
            "JSON_DUPLICATE_KEY",
            "The signed JSON contains a duplicate field.",
          );
        }
        keys.add(key);
        whitespace();
        if (text[position] !== ":") invalidJson();
        position += 1;
        output[key] = parseValue(depth + 1);
        whitespace();
        if (text[position] === "}") {
          position += 1;
          return output;
        }
        if (text[position] !== ",") invalidJson();
        position += 1;
      }
      invalidJson();
    }
    if (character === "[") {
      position += 1;
      whitespace();
      const output: unknown[] = [];
      if (text[position] === "]") {
        position += 1;
        return output;
      }
      while (position < text.length) {
        output.push(parseValue(depth + 1));
        whitespace();
        if (text[position] === "]") {
          position += 1;
          return output;
        }
        if (text[position] !== ",") invalidJson();
        position += 1;
      }
      invalidJson();
    }
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(token, position)) {
        position += token.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if (number !== null) {
      position += number[0].length;
      if (/[.eE]/.test(number[0])) {
        throw new OfflineGrantError(
          "JSON_NUMBER_UNSUPPORTED",
          "Signed JSON numbers must be integers.",
        );
      }
      const parsed: unknown = JSON.parse(number[0]);
      if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || Object.is(parsed, -0)) {
        throw new OfflineGrantError(
          "JSON_NUMBER_UNSUPPORTED",
          "Signed JSON has an unsupported integer.",
        );
      }
      return parsed;
    }
    invalidJson();
  };

  const result = parseValue(0);
  whitespace();
  if (position !== text.length) invalidJson();
  canonicalizeJcs(result);
  return result;
}

export function createDeviceProof(
  privateKey: KeyObject,
  grantId: string,
  challenge: Uint8Array,
): string {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new OfflineGrantError("DEVICE_KEY_INVALID", "The local device key is invalid.");
  }
  const message = deviceProofMessage(grantId, challenge);
  return signSignature(null, message, privateKey).toString("base64url");
}

export function privateKeyFromPkcs8Base64(value: string): KeyObject {
  try {
    const key = createPrivateKey({
      key: Buffer.from(value, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new OfflineGrantError("DEVICE_KEY_INVALID", "The local device key is damaged.");
  }
}

export function publicKeyRawFromPrivate(privateKey: KeyObject): Buffer {
  try {
    const exported = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const spki = Buffer.isBuffer(exported) ? exported : Buffer.from(exported as Uint8Array);
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      spki.length !== ED25519_SPKI_PREFIX.length + 32 ||
      !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
      throw new Error("unexpected Ed25519 key encoding");
    }
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  } catch {
    throw new OfflineGrantError("DEVICE_KEY_INVALID", "The local device key is invalid.");
  }
}

export function resolveTrustedTime(clock: OfflineClockEvidence): Date {
  const wall = validDate(clock.wallTime, "wall clock");
  const server = validDate(clock.lastTrustedServerTime, "trusted server time");
  const accepted = validDate(clock.lastAcceptedTime, "last accepted time");
  let floor = Math.max(server.getTime(), accepted.getTime());
  if (clock.monotonicAnchor !== undefined || clock.monotonicNowMs !== undefined) {
    if (clock.monotonicAnchor === undefined || clock.monotonicNowMs === undefined) {
      throw new OfflineGrantError(
        "CLOCK_EVIDENCE_INVALID",
        "Trusted monotonic time evidence is incomplete.",
      );
    }
    const anchor = validDate(clock.monotonicAnchor.trustedTime, "monotonic anchor");
    if (
      !Number.isFinite(clock.monotonicAnchor.monotonicMs) ||
      !Number.isFinite(clock.monotonicNowMs) ||
      clock.monotonicNowMs < clock.monotonicAnchor.monotonicMs
    ) {
      throw new OfflineGrantError(
        "CLOCK_EVIDENCE_INVALID",
        "Trusted monotonic time evidence is invalid.",
      );
    }
    floor = Math.max(
      floor,
      anchor.getTime() + clock.monotonicNowMs - clock.monotonicAnchor.monotonicMs,
    );
  }
  if (wall.getTime() + MAX_CLOCK_ROLLBACK_MS < floor) {
    throw new OfflineGrantError(
      "CLOCK_ROLLBACK",
      "The system clock moved backwards beyond the allowed tolerance.",
    );
  }
  return new Date(Math.max(wall.getTime(), floor));
}

export function verifyOfflineGrant(
  envelopeInput: unknown,
  input: OfflineGrantVerificationInput,
): OfflineGrantVerification {
  const envelope =
    typeof envelopeInput === "string" || envelopeInput instanceof Uint8Array
      ? parseStrictJcsJson(envelopeInput)
      : envelopeInput;
  const { payload, signature } = validateEnvelope(envelope);
  const trustedRawKey = input.trustedPublicKeys[payload.keyId];
  if (trustedRawKey === undefined) {
    throw new OfflineGrantError("KEY_UNTRUSTED", "The offline signing key is not trusted.");
  }
  const publicBytes = Buffer.from(trustedRawKey);
  if (publicBytes.length !== 32) {
    throw new OfflineGrantError(
      "KEY_UNTRUSTED",
      "The offline signing key configuration is invalid.",
    );
  }
  const signatureBytes = decodeBase64Url(signature, 64, "offline signature");
  const canonicalPayload = Buffer.from(canonicalizeJcs(payload), "utf8");
  let validSignature = false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicBytes]),
      format: "der",
      type: "spki",
    });
    validSignature = verifySignature(null, canonicalPayload, key, signatureBytes);
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    throw new OfflineGrantError(
      "SIGNATURE_INVALID",
      "The offline authorization signature is invalid.",
    );
  }
  if (payload.userId !== input.userId) {
    throw new OfflineGrantError(
      "USER_MISMATCH",
      "The offline authorization belongs to another account.",
    );
  }
  if (payload.deviceId !== input.deviceId) {
    throw new OfflineGrantError(
      "DEVICE_MISMATCH",
      "The offline authorization belongs to another device.",
    );
  }
  if (input.challenge.byteLength !== 32) {
    throw new OfflineGrantError(
      "DEVICE_PROOF_INVALID",
      "A fresh device proof challenge is required.",
    );
  }
  const localPublicKey = publicKeyRawFromPrivate(input.devicePrivateKey);
  const proof = decodeBase64Url(input.proofSignature, 64, "device proof");
  let validProof = false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, localPublicKey]),
      format: "der",
      type: "spki",
    });
    validProof = verifySignature(
      null,
      deviceProofMessage(payload.grantId, input.challenge),
      key,
      proof,
    );
  } catch {
    validProof = false;
  }
  if (!validProof) {
    throw new OfflineGrantError(
      "DEVICE_PROOF_INVALID",
      "The local device possession proof is invalid.",
    );
  }

  const codes = new Set<string>();
  const active: string[] = [];
  for (const item of payload.entitlements) {
    if (codes.has(item.code)) {
      throw new OfflineGrantError(
        "ENTITLEMENT_INVALID",
        "The offline authorization has duplicate entitlements.",
      );
    }
    codes.add(item.code);
    if (item.enabled) {
      if (!input.allowedEntitlements.has(item.code)) {
        throw new OfflineGrantError(
          "ENTITLEMENT_UNKNOWN",
          "The offline authorization grants an unsupported entitlement.",
        );
      }
      active.push(item.code);
    }
  }
  if (active.length === 0) {
    throw new OfflineGrantError(
      "ENTITLEMENT_MISSING",
      "The offline authorization has no active entitlement.",
    );
  }

  const issuedAt = parseUtcTimestamp(payload.issuedAt);
  const expiresAt = parseUtcTimestamp(payload.expiresAt);
  if (
    expiresAt.getTime() <= issuedAt.getTime() ||
    expiresAt.getTime() - issuedAt.getTime() > OFFLINE_GRANT_TTL_MS
  ) {
    throw new OfflineGrantError(
      "GRANT_LIFETIME_INVALID",
      "The offline authorization exceeds the 15-day lifetime limit.",
    );
  }
  const trustedNow = resolveTrustedTime(input.clock);
  if (issuedAt.getTime() > trustedNow.getTime() + MAX_CLOCK_ROLLBACK_MS) {
    throw new OfflineGrantError(
      "GRANT_NOT_YET_VALID",
      "The offline authorization issue time is not trusted yet.",
    );
  }
  if (trustedNow.getTime() >= expiresAt.getTime()) {
    throw new OfflineGrantError("GRANT_EXPIRED", "The offline authorization has expired.");
  }
  return {
    grantId: payload.grantId,
    issuedAt,
    expiresAt,
    entitlements: active,
    trustedNow,
    nextLastAcceptedTime: trustedNow,
  };
}

function validateEnvelope(value: unknown): {
  payload: GrantPayload;
  signature: string;
} {
  if (!isRecord(value) || !hasExactKeys(value, ["envelopeVersion", "payload", "signature"])) {
    throw new OfflineGrantError(
      "ENVELOPE_INVALID",
      "The offline authorization envelope fields are invalid.",
    );
  }
  if (value.envelopeVersion !== 1 || typeof value.signature !== "string") {
    throw new OfflineGrantError(
      "ENVELOPE_INVALID",
      "The offline authorization envelope version is unsupported.",
    );
  }
  decodeBase64Url(value.signature, 64, "offline signature");
  const raw = value.payload;
  const fields = [
    "schemaVersion",
    "grantId",
    "userId",
    "deviceId",
    "issuedAt",
    "expiresAt",
    "entitlements",
    "keyId",
  ];
  if (!isRecord(raw) || !hasExactKeys(raw, fields) || raw.schemaVersion !== 1) {
    throw new OfflineGrantError(
      "PAYLOAD_INVALID",
      "The offline authorization payload fields are invalid.",
    );
  }
  const strings = ["grantId", "userId", "deviceId", "issuedAt", "expiresAt", "keyId"] as const;
  if (strings.some((field) => typeof raw[field] !== "string")) {
    throw new OfflineGrantError(
      "PAYLOAD_INVALID",
      "The offline authorization payload has an invalid field type.",
    );
  }
  const grantId = raw.grantId as string;
  const userId = raw.userId as string;
  const deviceId = raw.deviceId as string;
  const issuedAt = raw.issuedAt as string;
  const expiresAt = raw.expiresAt as string;
  const keyId = raw.keyId as string;
  if (!UUID_PATTERN.test(grantId) || !UUID_PATTERN.test(userId) || !UUID_PATTERN.test(deviceId)) {
    throw new OfflineGrantError(
      "PAYLOAD_INVALID",
      "The offline authorization identity is malformed.",
    );
  }
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new OfflineGrantError("KEY_ID_INVALID", "The offline authorization key ID is malformed.");
  }
  const entitlements = raw.entitlements;
  if (!Array.isArray(entitlements) || entitlements.length > 128) {
    throw new OfflineGrantError(
      "ENTITLEMENT_INVALID",
      "The offline authorization entitlements are malformed.",
    );
  }
  const normalizedEntitlements: GrantEntitlement[] = entitlements.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["code", "enabled"])) {
      throw new OfflineGrantError(
        "ENTITLEMENT_INVALID",
        "The offline authorization entitlement is malformed.",
      );
    }
    if (
      typeof item.code !== "string" ||
      !ENTITLEMENT_PATTERN.test(item.code) ||
      typeof item.enabled !== "boolean"
    ) {
      throw new OfflineGrantError(
        "ENTITLEMENT_INVALID",
        "The offline authorization entitlement is malformed.",
      );
    }
    return { code: item.code, enabled: item.enabled };
  });
  parseUtcTimestamp(issuedAt);
  parseUtcTimestamp(expiresAt);
  return {
    payload: {
      schemaVersion: 1,
      grantId,
      userId,
      deviceId,
      issuedAt,
      expiresAt,
      entitlements: normalizedEntitlements,
      keyId,
    },
    signature: value.signature,
  };
}

interface GrantEntitlement {
  readonly code: string;
  readonly enabled: boolean;
}

interface GrantPayload {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly entitlements: readonly GrantEntitlement[];
  readonly keyId: string;
}

function deviceProofMessage(grantId: string, challenge: Uint8Array): Buffer {
  if (!UUID_PATTERN.test(grantId) || challenge.byteLength !== 32) {
    throw new OfflineGrantError(
      "DEVICE_PROOF_INVALID",
      "The local device proof fields are invalid.",
    );
  }
  return Buffer.concat([
    DEVICE_PROOF_DOMAIN,
    Buffer.from(grantId.replaceAll("-", ""), "hex"),
    Buffer.from(challenge),
  ]);
}

function decodeBase64Url(value: string, expectedBytes: number, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes("=")) {
    throw new OfflineGrantError("ENCODING_INVALID", `The ${field} encoding is invalid.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    throw new OfflineGrantError("ENCODING_INVALID", `The ${field} encoding is invalid.`);
  }
  return decoded;
}

function parseUtcTimestamp(value: string): Date {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new OfflineGrantError(
      "TIMESTAMP_INVALID",
      "Authorization timestamps must be RFC 3339 UTC values.",
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new OfflineGrantError(
      "TIMESTAMP_INVALID",
      "Authorization timestamps must be valid UTC values.",
    );
  }
  return date;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new OfflineGrantError("CLOCK_EVIDENCE_INVALID", `The ${label} evidence is invalid.`);
  }
  return value;
}

function canonicalize(value: unknown, ancestors: Set<object>, depth: number): string {
  if (depth > MAX_JSON_DEPTH) {
    throw new OfflineGrantError("JSON_TOO_DEEP", "The signed JSON document is too deeply nested.");
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new OfflineGrantError(
        "JSON_NUMBER_UNSUPPORTED",
        "Signed JSON numbers must be safe integers.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new OfflineGrantError("JSON_CYCLE", "Signed JSON cannot contain a cycle.");
    ancestors.add(value);
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new OfflineGrantError("JSON_INVALID", "Signed JSON arrays cannot be sparse.");
      }
      result.push(canonicalize(value[index], ancestors, depth + 1));
    }
    ancestors.delete(value);
    return `[${result.join(",")}]`;
  }
  if (isRecord(value)) {
    if (ancestors.has(value))
      throw new OfflineGrantError("JSON_CYCLE", "Signed JSON cannot contain a cycle.");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OfflineGrantError("JSON_INVALID", "Signed JSON objects must be plain objects.");
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new OfflineGrantError(
        "JSON_INVALID",
        "Signed JSON objects cannot contain symbol keys.",
      );
    }
    ancestors.add(value);
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        assertUnicode(key);
        const field = value[key];
        if (
          field === undefined ||
          typeof field === "bigint" ||
          typeof field === "function" ||
          typeof field === "symbol"
        ) {
          throw new OfflineGrantError("JSON_INVALID", "Signed JSON contains an unsupported value.");
        }
        return `${JSON.stringify(key)}:${canonicalize(field, ancestors, depth + 1)}`;
      });
    ancestors.delete(value);
    return `{${entries.join(",")}}`;
  }
  throw new OfflineGrantError("JSON_INVALID", "Signed JSON contains a non-JSON value.");
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new OfflineGrantError(
          "JSON_UNICODE_INVALID",
          "Signed JSON strings must contain Unicode scalar values.",
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new OfflineGrantError(
        "JSON_UNICODE_INVALID",
        "Signed JSON strings must contain Unicode scalar values.",
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function invalidJson(): never {
  throw new OfflineGrantError("JSON_INVALID", "The signed JSON document is malformed.");
}
