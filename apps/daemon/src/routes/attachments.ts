import { Readable } from "node:stream";
import {
  AttachmentDescriptorSchema,
  AttachmentDraftResponseSchema,
  AttachmentDraftWriteRequestSchema,
  AttachmentIdSchema,
  AttachmentOwnerSchema,
  MAX_ATTACHMENT_BYTES,
  type AttachmentOwner,
} from "@caelush/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AttachmentServiceError,
  type AttachmentService,
} from "../attachments/attachment-service.js";

const OwnerQuerySchema = z
  .object({
    ownerKind: z.enum(["WORKSPACE", "SESSION"]),
    ownerId: z.string().min(1).max(128),
  })
  .strict();

const ArtifactParamsSchema = z.object({ artifactId: AttachmentIdSchema }).strict();

export function registerAttachmentRoutes(app: FastifyInstance, service: AttachmentService): void {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser(
      "application/octet-stream",
      { bodyLimit: MAX_ATTACHMENT_BYTES },
      (_request, payload, done) => done(null, payload),
    );
  }

  app.post("/api/v1/attachments", async (request, reply) => {
    const owner = ownerFromHeaders(request);
    const name = singleHeader(request, "x-caelush-filename");
    const declaredMediaType = singleHeader(request, "x-caelush-media-type");
    const declaredLengthValue = request.headers["x-caelush-byte-length"];
    const declaredByteLength =
      typeof declaredLengthValue === "string" && /^\d{1,12}$/u.test(declaredLengthValue)
        ? Number(declaredLengthValue)
        : undefined;
    if (declaredLengthValue !== undefined && declaredByteLength === undefined) {
      throw new AttachmentServiceError("INVALID_REQUEST");
    }
    const body = request.body;
    if (!(body instanceof Readable)) throw new AttachmentServiceError("INVALID_REQUEST");
    const abort = new AbortController();
    const abortUpload = () => abort.abort();
    request.raw.once("aborted", abortUpload);
    try {
      const descriptor = await service.upload({
        owner,
        name,
        declaredMediaType,
        ...(declaredByteLength === undefined ? {} : { declaredByteLength }),
        stream: body,
        signal: abort.signal,
      });
      return reply.code(201).send(AttachmentDescriptorSchema.parse(descriptor));
    } finally {
      request.raw.removeListener("aborted", abortUpload);
    }
  });

  app.get("/api/v1/attachments/:artifactId", async (request, reply) => {
    const { artifactId } = safeParse(ArtifactParamsSchema, request.params);
    const query = safeParse(OwnerQuerySchema, request.query);
    const owner = ownerFromQuery(query);
    const [descriptor] = await service.getReadyForOwner([artifactId], owner);
    if (descriptor === undefined) throw new AttachmentServiceError("NOT_FOUND");
    const bytes = await service.download({ artifactId, owner });
    return reply
      .header("content-type", descriptor.mediaType)
      .header("content-length", bytes.byteLength)
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.name)}`,
      )
      .header("x-content-type-options", "nosniff")
      .send(bytes);
  });

  app.get(
    "/api/v1/attachment-drafts",
    { schema: { response: { 200: AttachmentDraftResponseSchema } } },
    async (request) => {
      const query = safeParse(OwnerQuerySchema, request.query);
      const owner = ownerFromQuery(query);
      const draft = await service.getDraft(owner);
      return { draft };
    },
  );

  app.put(
    "/api/v1/attachment-drafts",
    {
      schema: {
        body: AttachmentDraftWriteRequestSchema,
        response: { 200: AttachmentDraftResponseSchema },
      },
    },
    async (request) => {
      const body = safeParse(AttachmentDraftWriteRequestSchema, request.body);
      const { owner, expectedRevision, text, artifactIds, submissionId } = body;
      const draft = await service.saveDraft(owner, expectedRevision, {
        text,
        artifactIds,
        ...(submissionId === undefined ? {} : { submissionId }),
      });
      return { draft };
    },
  );
}

function ownerFromHeaders(request: FastifyRequest): AttachmentOwner {
  const kind = singleHeader(request, "x-caelush-owner-kind");
  const id = singleHeader(request, "x-caelush-owner-id");
  return ownerFromValues(kind, id);
}

function ownerFromQuery(query: z.infer<typeof OwnerQuerySchema>): AttachmentOwner {
  return ownerFromValues(query.ownerKind, query.ownerId);
}

function ownerFromValues(kind: string, id: string): AttachmentOwner {
  try {
    if (kind === "SESSION") return AttachmentOwnerSchema.parse({ kind, sessionId: id });
    if (kind === "WORKSPACE") return AttachmentOwnerSchema.parse({ kind, workspaceId: id });
  } catch {
    throw new AttachmentServiceError("INVALID_REQUEST");
  }
  throw new AttachmentServiceError("INVALID_REQUEST");
}

function singleHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new AttachmentServiceError("INVALID_REQUEST");
  }
  return value;
}

function safeParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AttachmentServiceError("INVALID_REQUEST");
  return result.data;
}
