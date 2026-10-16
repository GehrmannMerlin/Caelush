import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ArchiveDeletionSelectionSchema,
  TimestampMsSchema,
  createTimestampMs,
  type ArchiveDeletionSnapshot,
} from "@caelush/protocol";

export class ArchiveConfirmationError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "ARCHIVE_CONFIRMATION_EXPIRED") {
    super(
      code === "ARCHIVE_CONFIRMATION_EXPIRED"
        ? "The deletion confirmation expired; review it again."
        : "The deletion confirmation is invalid.",
    );
    this.name = "ArchiveConfirmationError";
  }
}
const payloadSchema = z
  .object({
    version: z.literal(1),
    scopeId: z.string().min(1).max(512),
    expiresAt: TimestampMsSchema,
    selection: ArchiveDeletionSelectionSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export function createArchiveConfirmationCodec(options: {
  scopeId: string;
  key?: Uint8Array;
  now?: () => number;
}) {
  const key = Buffer.from(options.key ?? randomBytes(32));
  const now = options.now ?? Date.now;
  if (key.byteLength < 32 || options.scopeId.length === 0 || options.scopeId.length > 512)
    throw new RangeError("Archive confirmation configuration is invalid.");
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest();
  return {
    issue(snapshot: ArchiveDeletionSnapshot) {
      const expiresAt = createTimestampMs(now() + 600000);
      const payload = Buffer.from(
        JSON.stringify(
          payloadSchema.parse({
            version: 1,
            scopeId: options.scopeId,
            expiresAt,
            selection: snapshot.selection,
            digest: snapshot.digest,
          }),
        ),
      ).toString("base64url");
      return { token: `${payload}.${sign(payload).toString("base64url")}`, expiresAt };
    },
    verify(token: string): Pick<ArchiveDeletionSnapshot, "selection" | "digest"> {
      try {
        if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token))
          throw new ArchiveConfirmationError("INVALID_REQUEST");
        const [payload, encodedSignature] = token.split(".") as [string, string];
        const signature = Buffer.from(encodedSignature, "base64url");
        if (
          signature.byteLength !== 32 ||
          signature.toString("base64url") !== encodedSignature ||
          !timingSafeEqual(signature, sign(payload))
        )
          throw new ArchiveConfirmationError("INVALID_REQUEST");
        const decoded = Buffer.from(payload, "base64url");
        if (decoded.toString("base64url") !== payload)
          throw new ArchiveConfirmationError("INVALID_REQUEST");
        const parsed = payloadSchema.parse(JSON.parse(decoded.toString("utf8")));
        if (parsed.scopeId !== options.scopeId)
          throw new ArchiveConfirmationError("INVALID_REQUEST");
        if (now() >= parsed.expiresAt)
          throw new ArchiveConfirmationError("ARCHIVE_CONFIRMATION_EXPIRED");
        return { selection: parsed.selection, digest: parsed.digest };
      } catch (error) {
        if (error instanceof ArchiveConfirmationError) throw error;
        throw new ArchiveConfirmationError("INVALID_REQUEST");
      }
    },
  };
}
