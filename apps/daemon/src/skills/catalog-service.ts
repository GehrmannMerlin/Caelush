import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  SkillCatalogPageV1Schema,
  SkillManagementPageV1Schema,
  type SkillCatalogPageV1,
  type SkillManagementItemV1,
  type SkillManagementPageV1,
} from "@caelush/protocol";
import {
  resolveSkillDiscovery,
  type EffectiveSkillCatalog,
  type SkillCandidate,
  type SkillDiagnostic,
  type SkillProviderPort,
} from "@caelush/skills";
import type { SkillSettingsRecord, SkillSettingsRepository } from "@caelush/storage";
import { resolveSkillFilesystemPolicy } from "./skill-policy.js";

type CatalogAudience = "USER" | "MANAGEMENT" | "MODEL";

const cursorSchema = z
  .object({
    version: z.literal(1),
    workspaceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    queryHash: z.string().regex(/^[a-f0-9]{64}$/u),
    catalogRevision: z.string().min(1).max(256),
    audience: z.enum(["USER", "MANAGEMENT", "MODEL"]),
    pageSize: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export class InvalidSkillCatalogCursorError extends Error {
  constructor() {
    super("The Skill catalog cursor is invalid for this query.");
    this.name = "InvalidSkillCatalogCursorError";
  }
}

export class StaleSkillCatalogCursorError extends Error {
  constructor() {
    super("The Skill catalog changed; refresh the list before continuing.");
    this.name = "StaleSkillCatalogCursorError";
  }
}

export interface SkillSelectionTokenInput {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly bundleRevision: string;
  readonly catalogRevision: string;
}

export interface SkillSelectionTokenCodec {
  create(input: SkillSelectionTokenInput): string;
  verify(input: SkillSelectionTokenInput, token: string): boolean;
}

export function createSkillSelectionTokenCodec(
  secret: Uint8Array = randomBytes(32),
): SkillSelectionTokenCodec {
  if (secret.byteLength < 32) throw new RangeError("Skill token secret must contain 32 bytes.");
  const key = Buffer.from(secret);
  const create = (input: SkillSelectionTokenInput) =>
    createHmac("sha256", key).update(tokenPayload(input), "utf8").digest("base64url");
  return Object.freeze({
    create: (input: SkillSelectionTokenInput) => create(input),
    verify: (input: SkillSelectionTokenInput, token: string) => {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
      const expected = Buffer.from(create(input), "base64url");
      const actual = Buffer.from(token, "base64url");
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    },
  });
}

export interface SkillCatalogServiceOptions {
  readonly provider: SkillProviderPort;
  readonly settings: Pick<SkillSettingsRepository, "getMany">;
  readonly selectionTokens?: SkillSelectionTokenCodec;
  readonly selectionTokenSecret?: Uint8Array;
  readonly policy?: Parameters<typeof resolveSkillFilesystemPolicy>[0];
}

export interface SkillCatalogQueryInput {
  readonly workspaceId: string;
  readonly query?: string;
  readonly cursor?: string;
  readonly pageSize: number;
  readonly signal: AbortSignal;
}

export interface SkillCatalogService {
  listUserCatalog(input: SkillCatalogQueryInput): Promise<SkillCatalogPageV1>;
  listManagementCatalog(input: SkillCatalogQueryInput): Promise<SkillManagementPageV1>;
  listModelCatalog(input: SkillCatalogQueryInput): Promise<SkillModelCatalogPage>;
  getManagementTarget(input: {
    readonly workspaceId: string;
    readonly skillId: string;
    readonly signal: AbortSignal;
  }): Promise<SkillManagementTarget>;
  invalidate(workspaceId?: string): void;
}

export interface SkillModelCatalogPage {
  readonly catalogRevision: string;
  readonly items: readonly SkillModelCatalogItem[];
  readonly nextCursor?: string;
  readonly inventoryComplete: boolean;
}

export interface SkillModelCatalogItem {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
}

export interface SkillManagementTarget {
  readonly catalogRevision: string;
  readonly item?: SkillManagementItemV1;
  /** Immutable manifest policy before a user settings override. */
  readonly modelInvocableAllowed: boolean;
}

interface CatalogSnapshot {
  readonly catalog: EffectiveSkillCatalog;
  readonly bytes: number;
}

interface CursorValue {
  readonly version: 1;
  readonly workspaceHash: string;
  readonly queryHash: string;
  readonly catalogRevision: string;
  readonly audience: CatalogAudience;
  readonly pageSize: number;
  readonly offset: number;
}

const DIAGNOSTICS_TRUNCATED: SkillDiagnostic = Object.freeze({
  code: "SKILL_DIAGNOSTICS_TRUNCATED",
  severity: "WARNING",
  safeMessage: "Additional Skill diagnostics were omitted.",
});

export function createSkillCatalogService(
  options: SkillCatalogServiceOptions,
): SkillCatalogService {
  const policy = resolveSkillFilesystemPolicy(options.policy);
  const selectionTokens =
    options.selectionTokens ?? createSkillSelectionTokenCodec(options.selectionTokenSecret);
  const cache = new Map<string, CatalogSnapshot>();
  let cachedBytes = 0;
  let cacheGeneration = 0;

  return Object.freeze({
    listUserCatalog: async (input: SkillCatalogQueryInput) =>
      (await listPage("USER", input)) as SkillCatalogPageV1,
    listManagementCatalog: async (input: SkillCatalogQueryInput) =>
      (await listPage("MANAGEMENT", input)) as SkillManagementPageV1,
    listModelCatalog: async (input: SkillCatalogQueryInput) =>
      (await listPage("MODEL", input)) as SkillModelCatalogPage,
    async getManagementTarget(input: {
      readonly workspaceId: string;
      readonly skillId: string;
      readonly signal: AbortSignal;
    }) {
      const snapshot = await getSnapshot(input.workspaceId, input.signal);
      const candidate = snapshot.catalog.entries.find(({ skillId }) => skillId === input.skillId);
      const settings = await options.settings.getMany(
        snapshot.catalog.entries.map(({ skillId }) => skillId),
      );
      const setting = candidate === undefined ? undefined : settings.get(input.skillId);
      const item = candidate === undefined ? undefined : toPublicItem(candidate, setting);
      return Object.freeze({
        catalogRevision: effectiveRevision(snapshot.catalog, settings),
        ...(item === undefined ? {} : { item }),
        modelInvocableAllowed: candidate?.manifest.modelInvocable ?? false,
      });
    },
    invalidate(workspaceId?: string) {
      if (workspaceId === undefined) {
        cacheGeneration += 1;
        cache.clear();
        cachedBytes = 0;
        return;
      }
      const snapshot = cache.get(workspaceId);
      cacheGeneration += 1;
      if (snapshot !== undefined) cachedBytes -= snapshot.bytes;
      cache.delete(workspaceId);
    },
  });

  async function listPage(
    audience: CatalogAudience,
    input: SkillCatalogQueryInput,
  ): Promise<SkillCatalogPageV1 | SkillManagementPageV1 | SkillModelCatalogPage> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
      throw new RangeError("Skill catalog page size must be between 1 and 100.");
    }
    if (input.signal.aborted)
      throw new DOMException("Skill discovery was cancelled.", "AbortError");

    const snapshot = await getSnapshot(input.workspaceId, input.signal);
    const settings = await options.settings.getMany(
      snapshot.catalog.entries.map(({ skillId }) => skillId),
    );
    const items = snapshot.catalog.entries
      .map((candidate) => toPublicItem(candidate, settings.get(candidate.skillId)))
      .filter(
        (item) =>
          audience === "MANAGEMENT" ||
          (audience === "USER"
            ? item.enabled && item.userInvocable
            : item.enabled && item.modelInvocable),
      )
      .filter((item) => matchesQuery(item.name, item.description, input.query));
    const catalogRevision = effectiveRevision(snapshot.catalog, settings);

    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (cursor !== undefined) {
      if (
        cursor.workspaceHash !== digest(input.workspaceId) ||
        cursor.queryHash !== digest(normalizeQuery(input.query)) ||
        cursor.audience !== audience ||
        cursor.pageSize !== input.pageSize
      ) {
        throw new InvalidSkillCatalogCursorError();
      }
      if (cursor.catalogRevision !== catalogRevision) throw new StaleSkillCatalogCursorError();
      if (cursor.offset >= items.length) throw new InvalidSkillCatalogCursorError();
    }

    const start = cursor?.offset ?? 0;
    const end = Math.min(start + input.pageSize, items.length);
    const pageItems = items.slice(start, end);
    const nextCursor =
      end < items.length
        ? encodeCursor({
            version: 1,
            workspaceHash: digest(input.workspaceId),
            queryHash: digest(normalizeQuery(input.query)),
            catalogRevision,
            audience,
            pageSize: input.pageSize,
            offset: end,
          })
        : undefined;
    const diagnostics = boundedDiagnostics(snapshot.catalog.diagnostics, policy.maxDiagnostics);

    if (audience === "MANAGEMENT") {
      return SkillManagementPageV1Schema.parse({
        schemaVersion: 1,
        catalogRevision,
        items: pageItems,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        complete: snapshot.catalog.complete,
        diagnostics,
      });
    }

    if (audience === "MODEL") {
      return {
        catalogRevision,
        items: pageItems.map(({ skillId, name, description }) => ({
          skillId,
          name,
          description,
        })),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        inventoryComplete: snapshot.catalog.complete,
      };
    }

    return SkillCatalogPageV1Schema.parse({
      schemaVersion: 1,
      catalogRevision,
      items: pageItems.map((item) => {
        const candidate = snapshot.catalog.entries.find(({ skillId }) => skillId === item.skillId);
        if (candidate === undefined)
          throw new Error("Catalog candidate disappeared during projection.");
        return {
          ...item,
          selectionToken: selectionTokens.create({
            workspaceId: input.workspaceId,
            skillId: candidate.skillId,
            bundleRevision: candidate.bundleRevision ?? "",
            catalogRevision,
          }),
        };
      }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      complete: snapshot.catalog.complete,
      diagnostics,
    });
  }

  async function getSnapshot(workspaceId: string, signal: AbortSignal): Promise<CatalogSnapshot> {
    const cached = cache.get(workspaceId);
    if (cached !== undefined) {
      cache.delete(workspaceId);
      cache.set(workspaceId, cached);
      return cached;
    }
    const generationAtStart = cacheGeneration;
    const discovered = await options.provider.discover({ workspaceId, signal });
    if (signal.aborted) throw new DOMException("Skill discovery was cancelled.", "AbortError");
    const catalog = resolveSkillDiscovery(discovered);
    const bytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
    const snapshot = Object.freeze({ catalog, bytes });
    if (cacheGeneration === generationAtStart && bytes <= policy.maxCatalogCacheBytes) {
      cache.set(workspaceId, snapshot);
      cachedBytes += bytes;
      while (cache.size > policy.maxCachedCatalogs || cachedBytes > policy.maxCatalogCacheBytes) {
        const oldest = cache.entries().next().value as [string, CatalogSnapshot] | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest[0]);
        cachedBytes -= oldest[1].bytes;
      }
    }
    return snapshot;
  }
}

function toPublicItem(candidate: SkillCandidate, settings: SkillSettingsRecord | undefined) {
  return {
    skillId: candidate.skillId,
    name: candidate.manifest.name,
    description: candidate.manifest.description,
    ...(candidate.manifest.metadata?.["displayName"] === undefined
      ? {}
      : { displayName: candidate.manifest.metadata["displayName"] }),
    enabled: settings?.enabled ?? true,
    userInvocable: candidate.manifest.userInvocable,
    modelInvocable: candidate.manifest.modelInvocable && settings?.modelInvocable !== false,
  };
}

function effectiveRevision(
  catalog: EffectiveSkillCatalog,
  settings: ReadonlyMap<string, SkillSettingsRecord>,
): string {
  const effectiveSettings = catalog.entries.map((candidate) => {
    const setting = settings.get(candidate.skillId);
    return [
      candidate.skillId,
      setting?.enabled ?? true,
      candidate.manifest.modelInvocable && setting?.modelInvocable !== false,
      setting?.version ?? 0,
    ];
  });
  const diagnostics = catalog.diagnostics.map(({ code, severity }) => [code, severity]);
  return `sha256:${digest(
    JSON.stringify([
      "caelush.skill.catalog-effective.v1",
      catalog.revision,
      catalog.complete,
      effectiveSettings,
      diagnostics,
    ]),
  )}`;
}

function boundedDiagnostics(
  diagnostics: readonly SkillDiagnostic[],
  limit: number,
): readonly SkillDiagnostic[] {
  if (diagnostics.length <= limit) return diagnostics;
  return Object.freeze([...diagnostics.slice(0, Math.max(0, limit - 1)), DIAGNOSTICS_TRUNCATED]);
}

function matchesQuery(name: string, description: string, query: string | undefined): boolean {
  const normalized = normalizeQuery(query);
  if (normalized === "") return true;
  return `${name}\n${description}`.toLowerCase().includes(normalized);
}

function normalizeQuery(query: string | undefined): string {
  return query?.trim().toLowerCase() ?? "";
}

function encodeCursor(cursor: CursorValue): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(encoded: string): CursorValue {
  if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new InvalidSkillCatalogCursorError();
  }
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (!parsed.success) throw new InvalidSkillCatalogCursorError();
    return parsed.data;
  } catch (error) {
    if (error instanceof InvalidSkillCatalogCursorError) throw error;
    throw new InvalidSkillCatalogCursorError();
  }
}

function tokenPayload(input: SkillSelectionTokenInput): string {
  return JSON.stringify([
    "caelush.skill.selection.v1",
    input.workspaceId,
    input.skillId,
    input.bundleRevision,
    input.catalogRevision,
  ]);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
