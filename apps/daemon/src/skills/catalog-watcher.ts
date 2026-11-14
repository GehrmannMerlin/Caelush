import { watch, type FSWatcher } from "node:fs";

export interface SkillCatalogWatchHandle {
  close(): void;
}

export type SkillCatalogWatchFactory = (
  root: string,
  onChange: () => void,
  onError: () => void,
) => SkillCatalogWatchHandle;

export interface SkillCatalogWatcherOptions {
  readonly roots: readonly string[];
  readonly debounceMs: number;
  readonly refresh: () => void | Promise<void>;
  readonly watchFactory?: SkillCatalogWatchFactory;
  readonly onError?: () => void;
}

export interface SkillCatalogWatcher {
  start(): Promise<void>;
  refreshNow(): Promise<void>;
  dispose(): Promise<void>;
}

export function createSkillCatalogWatcher(
  options: SkillCatalogWatcherOptions,
): SkillCatalogWatcher {
  if (
    !Number.isSafeInteger(options.debounceMs) ||
    options.debounceMs < 0 ||
    options.debounceMs > 5000
  ) {
    throw new RangeError("Skill catalog watcher debounce must be between 0 and 5000 ms.");
  }
  const handles = new Map<string, SkillCatalogWatchHandle>();
  const watchFactory = options.watchFactory ?? createNodeWatch;
  let started = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let refreshAgain = false;

  return {
    async start() {
      if (disposed) throw new Error("Skill catalog watcher is disposed.");
      if (started) return;
      started = true;
      for (const root of new Set(options.roots)) {
        try {
          const handle = watchFactory(root, schedule, () => options.onError?.());
          handles.set(root, handle);
        } catch {
          options.onError?.();
        }
      }
    },

    async refreshNow() {
      if (disposed) return;
      clearScheduledRefresh();
      if (refreshInFlight !== undefined) {
        refreshAgain = true;
        await refreshInFlight;
        if (disposed) return;
        clearScheduledRefresh();
        refreshAgain = false;
      }
      await runRefresh();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduledRefresh();
      for (const handle of handles.values()) {
        try {
          handle.close();
        } catch {
          options.onError?.();
        }
      }
      handles.clear();
    },
  };

  function schedule(): void {
    if (disposed) return;
    clearScheduledRefresh();
    timer = setTimeout(() => {
      timer = undefined;
      void runRefresh();
    }, options.debounceMs);
  }

  function clearScheduledRefresh(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  async function runRefresh(): Promise<void> {
    if (disposed) return;
    if (refreshInFlight !== undefined) {
      refreshAgain = true;
      return refreshInFlight;
    }
    const current = Promise.resolve()
      .then(() => options.refresh())
      .catch(() => options.onError?.())
      .then(() => undefined)
      .finally(() => {
        if (refreshInFlight === current) refreshInFlight = undefined;
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          schedule();
        }
      });
    refreshInFlight = current;
    return current;
  }
}

function createNodeWatch(
  root: string,
  onChange: () => void,
  onError: () => void,
): SkillCatalogWatchHandle {
  const watcher: FSWatcher = watch(root, { persistent: false, recursive: true }, onChange);
  watcher.on("error", onError);
  return { close: () => watcher.close() };
}
