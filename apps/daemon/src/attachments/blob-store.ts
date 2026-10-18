import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AttachmentIdSchema, MAX_ATTACHMENT_BYTES, type AttachmentId } from "@caelush/protocol";

export type AttachmentBlobStoreErrorCode = "RESOURCE_LIMIT" | "EMPTY_UPLOAD" | "BLOB_UNAVAILABLE";

export class AttachmentBlobStoreError extends Error {
  constructor(readonly code: AttachmentBlobStoreErrorCode) {
    super(`Attachment blob operation failed (${code}).`);
    this.name = "AttachmentBlobStoreError";
  }
}

export interface WrittenAttachmentBlob {
  readonly byteLength: number;
  readonly sha256: string;
}

export class AttachmentBlobStore {
  constructor(
    private readonly rootDirectory: string,
    private readonly maxBytes = MAX_ATTACHMENT_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_BYTES) {
      throw new RangeError("Attachment blob size limit is invalid.");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
  }

  async write(
    id: AttachmentId,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WrittenAttachmentBlob> {
    const artifactId = AttachmentIdSchema.parse(id);
    await this.initialize();
    const destination = this.blobPath(artifactId);
    try {
      await access(destination);
      throw new AttachmentBlobStoreError("BLOB_UNAVAILABLE");
    } catch (error) {
      if (error instanceof AttachmentBlobStoreError) throw error;
      if (!isFileNotFound(error)) throw new AttachmentBlobStoreError("BLOB_UNAVAILABLE");
    }

    const temporary = join(this.rootDirectory, `${artifactId}.${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let byteLength = 0;
    const limiter = new Transform({
      transform: (chunk: unknown, _encoding, callback) => {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : null;
        if (bytes === null) {
          callback(new AttachmentBlobStoreError("BLOB_UNAVAILABLE"));
          return;
        }
        byteLength += bytes.byteLength;
        if (byteLength > this.maxBytes) {
          callback(new AttachmentBlobStoreError("RESOURCE_LIMIT"));
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      },
    });

    let committed = false;
    try {
      await pipeline(
        Readable.from(source),
        limiter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        ...(signal === undefined ? [] : [{ signal }]),
      );
      if (byteLength === 0) throw new AttachmentBlobStoreError("EMPTY_UPLOAD");
      await rename(temporary, destination);
      committed = true;
      return { byteLength, sha256: hash.digest("hex") };
    } finally {
      if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async read(id: AttachmentId): Promise<Buffer> {
    try {
      const path = this.blobPath(AttachmentIdSchema.parse(id));
      const details = await lstat(path);
      if (!details.isFile() || details.size > this.maxBytes) {
        throw new AttachmentBlobStoreError("BLOB_UNAVAILABLE");
      }
      const bytes = await readFile(path);
      if (bytes.byteLength > this.maxBytes) throw new AttachmentBlobStoreError("BLOB_UNAVAILABLE");
      return bytes;
    } catch {
      throw new AttachmentBlobStoreError("BLOB_UNAVAILABLE");
    }
  }

  async inspect(id: AttachmentId): Promise<{ readonly byteLength: number } | null> {
    try {
      const details = await lstat(this.blobPath(AttachmentIdSchema.parse(id)));
      if (!details.isFile()) return null;
      return { byteLength: details.size };
    } catch {
      return null;
    }
  }

  async listBlobIds(): Promise<AttachmentId[]> {
    await this.initialize();
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const ids: AttachmentId[] = [];
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const match = /^(att_[A-Za-z0-9_-]{12,128})\.blob$/u.exec(entry.name);
      if (match === null) continue;
      const parsed = AttachmentIdSchema.safeParse(match[1]);
      if (parsed.success) ids.push(parsed.data);
    }
    return ids;
  }

  async remove(id: AttachmentId): Promise<void> {
    await rm(this.blobPath(AttachmentIdSchema.parse(id)), { force: true });
  }

  async cleanupTemporaryFiles(): Promise<void> {
    await this.initialize();
    for (const entry of await readdir(this.rootDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^att_[A-Za-z0-9_-]{12,128}\.[0-9a-f-]{36}\.tmp$/u.test(entry.name)) {
        await rm(join(this.rootDirectory, entry.name), { force: true });
      }
    }
  }

  private blobPath(id: AttachmentId): string {
    return join(this.rootDirectory, `${id}.blob`);
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
