import { z } from "zod";

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export const SkillFilesystemPolicySchema = z
  .object({
    maxDepth: z.number().int().min(1).max(8),
    maxEntriesPerRoot: z.number().int().min(1).max(100_000),
    maxBytesPerRoot: z
      .number()
      .int()
      .min(1)
      .max(2 * GiB),
    maxManifestBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * KiB),
    maxPackageBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * MiB),
    maxPackageFiles: z.number().int().min(1).max(4096),
    maxResourceBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * MiB),
    maxDiagnostics: z.number().int().min(1).max(100),
    maxCachedCatalogs: z.number().int().min(1).max(128),
    maxCatalogCacheBytes: z
      .number()
      .int()
      .min(1)
      .max(512 * MiB),
    bundleQuotaBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    watcherDebounceMs: z.number().int().min(0).max(5000),
  })
  .strict();

export type SkillFilesystemPolicy = z.infer<typeof SkillFilesystemPolicySchema>;

export const DEFAULT_SKILL_FILESYSTEM_POLICY: SkillFilesystemPolicy = Object.freeze(
  SkillFilesystemPolicySchema.parse({
    maxDepth: 8,
    maxEntriesPerRoot: 100_000,
    maxBytesPerRoot: GiB,
    maxManifestBytes: 256 * KiB,
    maxPackageBytes: 64 * MiB,
    maxPackageFiles: 4096,
    maxResourceBytes: 16 * MiB,
    maxDiagnostics: 100,
    maxCachedCatalogs: 32,
    maxCatalogCacheBytes: 64 * MiB,
    bundleQuotaBytes: GiB,
    watcherDebounceMs: 75,
  }),
);

export function resolveSkillFilesystemPolicy(
  overrides: Partial<SkillFilesystemPolicy> = {},
): SkillFilesystemPolicy {
  return Object.freeze(
    SkillFilesystemPolicySchema.parse({ ...DEFAULT_SKILL_FILESYSTEM_POLICY, ...overrides }),
  );
}
