import { Worker } from "node:worker_threads";
import {
  AttachmentIdSchema,
  AttachmentMediaTypeSchema,
  AttachmentNameSchema,
  AttachmentProcessingManifestSchema,
  AttachmentReadRangeSchema,
  AttachmentReadResultSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_READ_RESULT_BYTES,
  type AttachmentId,
  type AttachmentProcessingManifest,
  type AttachmentReadRange,
  type AttachmentReadResult,
} from "@caelush/protocol";
import {
  DOCUMENT_PROCESSOR_HEAP_MB,
  DOCUMENT_PROCESSOR_LIMITS,
  DOCUMENT_PROCESSOR_TIMEOUT_MS,
} from "./processor-limits.js";

export type DocumentProcessorErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "INVALID_DOCUMENT"
  | "PASSWORD_REQUIRED"
  | "RESOURCE_LIMIT"
  | "CONTENT_HASH_MISMATCH"
  | "PROCESSOR_TIMEOUT"
  | "PROCESSOR_CANCELLED"
  | "PROCESSOR_FAILED";

export class DocumentProcessorError extends Error {
  constructor(readonly code: DocumentProcessorErrorCode) {
    super(`Attachment processing failed (${code}).`);
    this.name = "DocumentProcessorError";
  }
}

export interface InspectAttachmentInput {
  readonly artifactId: AttachmentId;
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly detectedMediaType: string;
  readonly signal?: AbortSignal;
}

export interface ReadAttachmentInput {
  readonly bytes: Uint8Array;
  readonly manifest: AttachmentProcessingManifest;
  readonly range: AttachmentReadRange;
  readonly signal?: AbortSignal;
}

export interface DocumentProcessor {
  inspect(input: InspectAttachmentInput): Promise<AttachmentProcessingManifest>;
  read(input: ReadAttachmentInput): Promise<AttachmentReadResult>;
}

interface WorkerReply<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly code?: DocumentProcessorErrorCode;
}

export function createDocumentProcessor(
  options: { readonly timeoutMs?: number } = {},
): DocumentProcessor {
  const timeoutMs = options.timeoutMs ?? DOCUMENT_PROCESSOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("Attachment processor timeout is outside its supported range.");
  }

  return Object.freeze({
    async inspect(input: InspectAttachmentInput): Promise<AttachmentProcessingManifest> {
      const artifactId = AttachmentIdSchema.parse(input.artifactId);
      const name = AttachmentNameSchema.parse(input.name);
      const detectedMediaType = AttachmentMediaTypeSchema.parse(input.detectedMediaType);
      assertInputBytes(input.bytes);
      const value = await runWorker<unknown>(
        {
          operation: "INSPECT",
          artifactId,
          bytes: input.bytes,
          name,
          detectedMediaType,
        },
        timeoutMs,
        input.signal,
      );
      return AttachmentProcessingManifestSchema.parse(value);
    },

    async read(input: ReadAttachmentInput): Promise<AttachmentReadResult> {
      const manifest = AttachmentProcessingManifestSchema.parse(input.manifest);
      const range = AttachmentReadRangeSchema.parse(input.range);
      assertInputBytes(input.bytes);
      const value = await runWorker<unknown>(
        { operation: "READ", bytes: input.bytes, manifest, range },
        timeoutMs,
        input.signal,
      );
      const result = AttachmentReadResultSchema.parse(value);
      if (result.outputBytes > MAX_ATTACHMENT_READ_RESULT_BYTES) {
        throw new DocumentProcessorError("RESOURCE_LIMIT");
      }
      return result;
    },
  });
}

function assertInputBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new DocumentProcessorError("INVALID_DOCUMENT");
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new DocumentProcessorError("RESOURCE_LIMIT");
  }
}

function workerUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts")
      ? "./document-processor-worker.ts"
      : "./document-processor-worker.js",
    import.meta.url,
  );
}

function runWorker<T>(
  command: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DocumentProcessorError("PROCESSOR_CANCELLED"));

  const bytes = command["bytes"];
  if (!(bytes instanceof Uint8Array))
    return Promise.reject(new DocumentProcessorError("PROCESSOR_FAILED"));
  const transferableBytes = Uint8Array.from(bytes);
  const workerCommand = { ...command, bytes: transferableBytes, limits: DOCUMENT_PROCESSOR_LIMITS };
  const sourceUrl = workerUrl();
  const isSourceTypeScript = sourceUrl.href.endsWith(".ts");
  const execArgv = isSourceTypeScript
    ? [...process.execArgv, "--experimental-strip-types"]
    : process.execArgv;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(sourceUrl, {
        workerData: workerCommand,
        transferList: [transferableBytes.buffer],
        execArgv,
        resourceLimits: {
          maxOldGenerationSizeMb: DOCUMENT_PROCESSOR_HEAP_MB,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });
    } catch {
      reject(new DocumentProcessorError("PROCESSOR_FAILED"));
      return;
    }
    const timer = setTimeout(() => finishError("PROCESSOR_TIMEOUT"), timeoutMs);
    const onAbort = () => finishError("PROCESSOR_CANCELLED");
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.once("message", (reply: WorkerReply<T>) => {
      if (!reply.ok) {
        finishError(reply.code ?? "PROCESSOR_FAILED");
        return;
      }
      finish(() => resolve(reply.value as T));
    });
    worker.once("error", (error: NodeJS.ErrnoException) =>
      finishError(
        error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "RESOURCE_LIMIT" : "PROCESSOR_FAILED",
      ),
    );
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finishError("PROCESSOR_FAILED");
    });

    function finish(complete: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      complete();
      void worker.terminate().catch(() => undefined);
    }

    function finishError(code: DocumentProcessorErrorCode): void {
      finish(() => reject(new DocumentProcessorError(code)));
    }
  });
}
