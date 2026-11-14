import multipart from "@fastify/multipart";
import {
  SkillCapabilityResponseSchema,
  SkillCatalogPageV1Schema,
  SkillCatalogQuerySchema,
  SkillIdSchema,
  SkillImportManifestV1Schema,
  SkillImportReceiptV1Schema,
  SkillImportTargetSchema,
  SkillManagementPageV1Schema,
  SkillManagementQuerySchema,
  SkillSettingsUpdateRequestSchema,
  SkillSettingsUpdateResponseSchema,
  WorkspaceIdParamSchema,
  type SkillImportFileManifestEntry,
  type SkillImportTarget,
  type WorkspaceId,
} from "@caelush/protocol";
import type { SkillSettingsRepository } from "@caelush/storage";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SkillCatalogService } from "../skills/catalog-service.js";
import {
  SkillImportServiceError,
  type SkillImportService,
} from "../skills/bundle-import-service.js";
import {
  assertSkillCapabilityAvailable,
  createSkillCapabilityResponse,
  DEFAULT_SKILL_FEATURE_READINESS,
  SkillServiceError,
  type SkillFeatureReadiness,
} from "../skills/feature-policy.js";
import { resolveSkillFilesystemPolicy } from "../skills/skill-policy.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const IMPORT_FIELD_BYTES_LIMIT = 20 * MiB;
const IMPORT_REQUEST_BYTES_LIMIT = 64 * MiB + IMPORT_FIELD_BYTES_LIMIT + 2 * MiB;
const IMPORT_PARAMS_SCHEMA = z
  .object({ workspaceId: WorkspaceIdParamSchema.shape.workspaceId })
  .strict();
const SKILL_SETTINGS_PARAMS_SCHEMA = z
  .object({ workspaceId: WorkspaceIdParamSchema.shape.workspaceId, skillId: SkillIdSchema })
  .strict();

export interface SkillRouteDependencies {
  readonly catalog?: SkillCatalogService;
  readonly settings?: Pick<SkillSettingsRepository, "get" | "compareAndSwap">;
  readonly importer?: Pick<SkillImportService, "import">;
  readonly readiness?: SkillFeatureReadiness;
  readonly workspaceService?: WorkspaceService;
  readonly watchWorkspace?: (workspaceId: string) => Promise<void>;
}

export class SkillSettingsRevisionConflictError extends Error {
  constructor() {
    super("Skill settings changed; refresh the catalog before updating them.");
    this.name = "SkillSettingsRevisionConflictError";
  }
}

export function registerSkillRoutes(
  app: FastifyInstance,
  dependencies: SkillRouteDependencies = {},
): void {
  const readiness = dependencies.readiness ?? DEFAULT_SKILL_FEATURE_READINESS;
  const policy = resolveSkillFilesystemPolicy();
  if (dependencies.importer !== undefined) {
    app.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        fieldNameSize: 64,
        fieldSize: IMPORT_FIELD_BYTES_LIMIT,
        fields: 3,
        fileSize: policy.maxResourceBytes,
        files: policy.maxPackageFiles,
        headerPairs: 16,
        parts: policy.maxPackageFiles + 3,
      },
    });
  }

  app.get(
    "/api/v1/skills/capabilities",
    { schema: { response: { 200: SkillCapabilityResponseSchema } } },
    async () => createSkillCapabilityResponse(readiness),
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/skills",
    {
      schema: {
        params: WorkspaceIdParamSchema,
        querystring: SkillCatalogQuerySchema,
        response: { 200: SkillCatalogPageV1Schema },
      },
    },
    async (request) => {
      const { workspaceId } = IMPORT_PARAMS_SCHEMA.parse(request.params);
      const query = SkillCatalogQuerySchema.parse(request.query);
      await requireWorkspace(dependencies.workspaceService, workspaceId);
      const catalog = requireCatalog(dependencies.catalog, readiness);
      await startWatcher(dependencies.watchWorkspace, workspaceId);
      return catalog.listUserCatalog({
        workspaceId,
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        pageSize: query.pageSize,
        signal: requestSignal(request),
      });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/skills/management",
    {
      schema: {
        params: WorkspaceIdParamSchema,
        querystring: SkillManagementQuerySchema,
        response: { 200: SkillManagementPageV1Schema },
      },
    },
    async (request) => {
      const { workspaceId } = IMPORT_PARAMS_SCHEMA.parse(request.params);
      const query = SkillManagementQuerySchema.parse(request.query);
      await requireWorkspace(dependencies.workspaceService, workspaceId);
      const catalog = requireCatalog(dependencies.catalog, readiness);
      await startWatcher(dependencies.watchWorkspace, workspaceId);
      return catalog.listManagementCatalog({
        workspaceId,
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        pageSize: query.pageSize,
        signal: requestSignal(request),
      });
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspaceId/skills/:skillId/settings",
    {
      schema: {
        params: SKILL_SETTINGS_PARAMS_SCHEMA,
        body: SkillSettingsUpdateRequestSchema,
        response: { 200: SkillSettingsUpdateResponseSchema },
      },
    },
    async (request) => {
      const { workspaceId, skillId } = SKILL_SETTINGS_PARAMS_SCHEMA.parse(request.params);
      const body = SkillSettingsUpdateRequestSchema.parse(request.body);
      await requireWorkspace(dependencies.workspaceService, workspaceId);
      const catalog = requireCatalog(dependencies.catalog, readiness);
      assertSkillCapabilityAvailable(createSkillCapabilityResponse(readiness), "catalog");
      if (dependencies.settings === undefined) throw new SkillServiceError("SKILLS_UNAVAILABLE");
      await startWatcher(dependencies.watchWorkspace, workspaceId);
      const target = await catalog.getManagementTarget({
        workspaceId,
        skillId,
        signal: requestSignal(request),
      });
      if (target.catalogRevision !== body.expectedCatalogRevision) {
        throw new SkillSettingsRevisionConflictError();
      }
      if (target.item === undefined) {
        throw new SkillServiceError("SKILL_NOT_FOUND");
      }
      const current = await dependencies.settings.get(skillId);
      const patch = {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.modelInvocable === undefined
          ? {}
          : { modelInvocable: target.modelInvocableAllowed && body.modelInvocable }),
      };
      const result = await dependencies.settings.compareAndSwap({
        skillId,
        expectedVersion: current.version,
        patch,
      });
      if (!result.ok) throw new SkillSettingsRevisionConflictError();
      catalog.invalidate(workspaceId);
      const updatedTarget = await catalog.getManagementTarget({
        workspaceId,
        skillId,
        signal: requestSignal(request),
      });
      if (updatedTarget.item === undefined) throw new SkillServiceError("SKILL_NOT_FOUND");
      return SkillSettingsUpdateResponseSchema.parse({
        schemaVersion: 1,
        catalogRevision: updatedTarget.catalogRevision,
        settings: {
          skillId,
          enabled: result.settings.enabled,
          modelInvocable: updatedTarget.item.modelInvocable,
          version: result.settings.version,
        },
      });
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/skills/import",
    { schema: { params: WorkspaceIdParamSchema, response: { 201: SkillImportReceiptV1Schema } } },
    async (request, reply) => {
      const { workspaceId } = IMPORT_PARAMS_SCHEMA.parse(request.params);
      await requireWorkspace(dependencies.workspaceService, workspaceId);
      assertSkillCapabilityAvailable(createSkillCapabilityResponse(readiness), "catalog");
      const importer = dependencies.importer;
      if (importer === undefined) throw new SkillServiceError("SKILLS_UNAVAILABLE");
      assertDeclaredImportLength(request);
      const signal = requestSignal(request);
      const abortController = new AbortController();
      const onAborted = () => abortController.abort();
      request.raw.once("aborted", onAborted);
      try {
        const imported = await readImportParts(request, signal, policy);
        const receipt = await importer.import({
          workspaceId,
          target: imported.target,
          files: imported.files,
          ...(imported.expectedRevision === undefined
            ? {}
            : { expectedRevision: imported.expectedRevision }),
          signal: abortController.signal,
        });
        dependencies.catalog?.invalidate(
          imported.target === "ALL_PROJECTS" ? undefined : workspaceId,
        );
        await startWatcher(dependencies.watchWorkspace, workspaceId);
        return reply
          .code(201)
          .send(SkillImportReceiptV1Schema.parse({ schemaVersion: 1, ...receipt }));
      } finally {
        request.raw.removeListener("aborted", onAborted);
      }
    },
  );
}

async function readImportParts(
  request: FastifyRequest,
  signal: AbortSignal,
  policy: ReturnType<typeof resolveSkillFilesystemPolicy>,
): Promise<{
  readonly target: SkillImportTarget;
  readonly expectedRevision?: string;
  readonly files: readonly { readonly relativePath: string; readonly bytes: Uint8Array }[];
}> {
  const fields = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  let totalFileBytes = 0;
  let totalFieldBytes = 0;
  try {
    for await (const part of request.parts({
      limits: {
        fieldNameSize: 64,
        fieldSize: IMPORT_FIELD_BYTES_LIMIT,
        fields: 3,
        fileSize: policy.maxResourceBytes,
        files: policy.maxPackageFiles,
        headerPairs: 16,
        parts: policy.maxPackageFiles + 3,
      },
    })) {
      checkImportCancelled(signal);
      if (part.type === "field") {
        if (!new Set(["target", "manifest", "expectedRevision"]).has(part.fieldname)) {
          throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        }
        const value =
          typeof part.value === "string"
            ? part.value
            : part.fieldname === "manifest"
              ? JSON.stringify(part.value)
              : undefined;
        if (fields.has(part.fieldname) || value === undefined) {
          throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        }
        totalFieldBytes += Buffer.byteLength(value, "utf8");
        if (totalFieldBytes > IMPORT_FIELD_BYTES_LIMIT + 512) {
          throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        }
        fields.set(part.fieldname, value);
        continue;
      }

      if (!/^file-[0-9]{1,4}$/u.test(part.fieldname) || files.has(part.fieldname)) {
        part.file.resume();
        throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
      }
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      for await (const chunk of part.file) {
        checkImportCancelled(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        fileBytes += bytes.byteLength;
        totalFileBytes += bytes.byteLength;
        if (fileBytes > policy.maxResourceBytes) {
          throw new SkillImportServiceError("SKILL_RESOURCE_TOO_LARGE");
        }
        if (totalFileBytes > policy.maxPackageBytes) {
          throw new SkillImportServiceError("SKILL_PACKAGE_TOO_LARGE");
        }
        chunks.push(bytes);
      }
      if (part.file.truncated) throw new SkillImportServiceError("SKILL_RESOURCE_TOO_LARGE");
      files.set(part.fieldname, Buffer.concat(chunks, fileBytes));
      if (files.size > policy.maxPackageFiles) {
        throw new SkillImportServiceError("SKILL_PACKAGE_FILE_LIMIT");
      }
    }
  } catch (error) {
    if (error instanceof SkillImportServiceError) throw error;
    if (signal.aborted || isAbortError(error))
      throw new SkillImportServiceError("SKILL_IMPORT_CANCELLED");
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }

  const rawManifest = fields.get("manifest");
  const rawTarget = fields.get("target");
  if (rawManifest === undefined || rawTarget === undefined) {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  let manifest;
  try {
    manifest = SkillImportManifestV1Schema.parse(JSON.parse(rawManifest));
  } catch {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  let target: SkillImportTarget;
  try {
    target = SkillImportTargetSchema.parse(rawTarget);
  } catch {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  const seenFields = new Set<string>();
  const manifestFiles: SkillImportFileManifestEntry[] = manifest.files;
  if (manifestFiles.length !== files.size)
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  const importedFiles = manifestFiles.map(({ field, relativePath }) => {
    if (seenFields.has(field)) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    seenFields.add(field);
    const bytes = files.get(field);
    if (bytes === undefined) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    return { relativePath, bytes };
  });
  if (seenFields.size !== files.size) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  const expectedRevision = fields.get("expectedRevision");
  if (expectedRevision !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(expectedRevision)) {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  return {
    target,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    files: importedFiles,
  };
}

function requireCatalog(
  catalog: SkillCatalogService | undefined,
  readiness: SkillFeatureReadiness,
): SkillCatalogService {
  assertSkillCapabilityAvailable(createSkillCapabilityResponse(readiness), "catalog");
  if (catalog === undefined) throw new SkillServiceError("SKILLS_UNAVAILABLE");
  return catalog;
}

async function requireWorkspace(
  workspaceService: WorkspaceService | undefined,
  workspaceId: WorkspaceId,
): Promise<void> {
  if (workspaceService === undefined) throw new SkillServiceError("SKILLS_UNAVAILABLE");
  await workspaceService.requireWorkspace(workspaceId);
}

async function startWatcher(
  watchWorkspace: SkillRouteDependencies["watchWorkspace"],
  workspaceId: WorkspaceId,
): Promise<void> {
  try {
    await watchWorkspace?.(workspaceId);
  } catch {
    // Discovery remains usable when the optional filesystem watcher cannot attach.
  }
}

function requestSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  if (request.raw.aborted) controller.abort();
  else request.raw.once("aborted", () => controller.abort());
  return controller.signal;
}

function assertDeclaredImportLength(request: FastifyRequest): void {
  const value = request.headers["content-length"];
  if (value === undefined) return;
  const length = typeof value === "string" && /^\d{1,12}$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(length) || length > IMPORT_REQUEST_BYTES_LIMIT) {
    throw new SkillImportServiceError("SKILL_PACKAGE_TOO_LARGE");
  }
}

function checkImportCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SkillImportServiceError("SKILL_IMPORT_CANCELLED");
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
