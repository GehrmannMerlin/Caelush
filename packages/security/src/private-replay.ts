import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { assertPrivateReplayIdentity, PrivateReplayError } from "@caelush/agent";
import type {
  EncryptedPrivateReplay,
  PrivateReplayIdentity,
  ReplayProtectionPort,
} from "@caelush/agent";

/** Each lookup returns owned key bytes; the consumer wipes them after use. */
export interface ReplayKey {
  readonly keyId: string;
  readonly bytes: Uint8Array;
}
export interface ReplayKeyProvider {
  current(): Promise<ReplayKey>;
  get(keyId: string): Promise<ReplayKey | undefined>;
}

/** Persistent secret injection for non-Windows hosts; lifecycle belongs to the trusted host. */
export function createInjectedReplayKeyProvider(
  keyId: string,
  secret: Uint8Array,
): ReplayKeyProvider {
  assertKey({ keyId, bytes: secret });
  const retained = Uint8Array.from(secret);
  return Object.freeze({
    current: async () => ({ keyId, bytes: Uint8Array.from(retained) }),
    get: async (requested: string) =>
      requested === keyId ? { keyId, bytes: Uint8Array.from(retained) } : undefined,
  });
}

/** 8 MiB is an explicit envelope byte limit, not a model token estimate. Oversize is refused. */
export const MAX_PRIVATE_REPLAY_BYTES = 8 * 1024 * 1024;

function assertKey(key: ReplayKey): void {
  if (
    !(key.bytes instanceof Uint8Array) ||
    key.bytes.length !== 32 ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(key.keyId)
  )
    throw new PrivateReplayError();
}

function identityBytes(identity: PrivateReplayIdentity): Buffer {
  assertPrivateReplayIdentity(identity);
  return Buffer.from(
    JSON.stringify([
      "caelush.private-replay",
      1,
      identity.replayVersion,
      identity.sessionId,
      identity.runId,
      identity.messageId,
      identity.callId,
      identity.providerId,
      identity.model,
      identity.api,
    ]),
  );
}

function decode(value: string, size?: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_PRIVATE_REPLAY_BYTES / 3) * 4)
    throw new PrivateReplayError();
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value || (size !== undefined && result.length !== size))
    throw new PrivateReplayError();
  return result;
}

function deriveKey(master: Uint8Array, purpose: "encryption" | "equality"): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      master,
      Buffer.from("caelush.private-replay.v1"),
      Buffer.from(`caelush.private-replay.${purpose}.v1`),
      32,
    ),
  );
}

function mac(key: Uint8Array, identity: Buffer, content: Uint8Array): string {
  return createHmac("sha256", key)
    .update("caelush.replay.equality.v1\0")
    .update(identity)
    .update(content)
    .digest("base64");
}

function aad(identity: Buffer, keyId: string, contentMac: string): Buffer {
  return Buffer.concat([identity, Buffer.from(JSON.stringify([1, keyId, contentMac]))]);
}

export function createReplayProtection(provider: ReplayKeyProvider): ReplayProtectionPort {
  async function open(
    identity: PrivateReplayIdentity,
    envelope: EncryptedPrivateReplay,
  ): Promise<Uint8Array> {
    let key: ReplayKey | undefined;
    let partial: Buffer | undefined;
    let encryptionKey: Buffer | undefined;
    let equalityKey: Buffer | undefined;
    try {
      const bound = identityBytes(identity);
      if (
        envelope.version !== 1 ||
        Object.keys(envelope).sort().join(",") !== "ciphertext,contentMac,keyId,nonce,tag,version"
      )
        throw new PrivateReplayError();
      const nonce = decode(envelope.nonce, 12);
      const tag = decode(envelope.tag, 16);
      const ciphertext = decode(envelope.ciphertext);
      const contentMac = decode(envelope.contentMac, 32);
      if (ciphertext.length > MAX_PRIVATE_REPLAY_BYTES) throw new PrivateReplayError();
      key = await provider.get(envelope.keyId);
      if (key === undefined || key.keyId !== envelope.keyId) throw new PrivateReplayError();
      assertKey(key);
      encryptionKey = deriveKey(key.bytes, "encryption");
      equalityKey = deriveKey(key.bytes, "equality");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(aad(bound, key.keyId, envelope.contentMac));
      decipher.setAuthTag(tag);
      partial = decipher.update(ciphertext);
      const final = decipher.final();
      const result = Buffer.concat([partial, final]);
      final.fill(0);
      if (!timingSafeEqual(contentMac, Buffer.from(mac(equalityKey, bound, result), "base64"))) {
        result.fill(0);
        throw new PrivateReplayError();
      }
      return result;
    } catch {
      throw new PrivateReplayError();
    } finally {
      partial?.fill(0);
      encryptionKey?.fill(0);
      equalityKey?.fill(0);
      key?.bytes.fill(0);
    }
  }

  return Object.freeze({
    async seal(
      identity: PrivateReplayIdentity,
      content: Uint8Array,
    ): Promise<EncryptedPrivateReplay> {
      let key: ReplayKey | undefined;
      let plaintext: Uint8Array | undefined;
      let encryptionKey: Buffer | undefined;
      let equalityKey: Buffer | undefined;
      try {
        const bound = identityBytes(identity);
        if (!(content instanceof Uint8Array) || content.byteLength > MAX_PRIVATE_REPLAY_BYTES)
          throw new PrivateReplayError();
        plaintext = Uint8Array.from(content);
        key = await provider.current();
        assertKey(key);
        encryptionKey = deriveKey(key.bytes, "encryption");
        equalityKey = deriveKey(key.bytes, "equality");
        const nonce = randomBytes(12);
        const contentMac = mac(equalityKey, bound, plaintext);
        const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce, {
          authTagLength: 16,
        });
        cipher.setAAD(aad(bound, key.keyId, contentMac));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return Object.freeze({
          version: 1,
          keyId: key.keyId,
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          contentMac,
        });
      } catch {
        throw new PrivateReplayError();
      } finally {
        plaintext?.fill(0);
        encryptionKey?.fill(0);
        equalityKey?.fill(0);
        key?.bytes.fill(0);
      }
    },
    open,
    async verify(identity: PrivateReplayIdentity, envelope: EncryptedPrivateReplay): Promise<void> {
      (await open(identity, envelope)).fill(0);
    },
  });
}
