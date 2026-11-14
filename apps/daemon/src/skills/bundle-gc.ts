import type {
  FilesystemSkillBundleStore,
  SkillBundleGarbageCollectionResult,
} from "./bundle-store.js";

export interface SkillBundleGarbageCollector {
  collect(): Promise<SkillBundleGarbageCollectionResult>;
}

/** Exposes the store's serialized, reference-aware GC as a daemon-owned service. */
export function createSkillBundleGarbageCollector(
  store: Pick<FilesystemSkillBundleStore, "collectGarbage">,
): SkillBundleGarbageCollector {
  return Object.freeze({ collect: () => store.collectGarbage() });
}
