import {
  parseThemePreference,
  resolveThemePreference,
  type AppearanceController,
  type AppearanceSnapshot,
  type ResolvedTheme,
  type ThemePreference,
} from "@caelush/ui-theme/appearance";

export const WEB_APPEARANCE_STORAGE_KEY = "caelush.appearance.v1";

export interface WebAppearanceEnvironment {
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly mediaQuery: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
  readonly storageEvents: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly applyTheme: (theme: ResolvedTheme) => void;
}

export function createWebAppearanceController(
  environment: WebAppearanceEnvironment = createBrowserEnvironment(),
): AppearanceController {
  const listeners = new Set<(snapshot: AppearanceSnapshot) => void>();
  let systemTheme: ResolvedTheme = environment.mediaQuery.matches ? "dark" : "light";
  let preference = readPreference(environment.storage);
  let disposed = false;
  let snapshot = freezeSnapshot(preference, systemTheme, 0);

  environment.applyTheme(snapshot.resolvedTheme);

  const publish = (nextPreference: ThemePreference, nextSystemTheme = systemTheme) => {
    systemTheme = nextSystemTheme;
    const resolvedTheme = resolveThemePreference(nextPreference, systemTheme);
    if (snapshot.preference === nextPreference && snapshot.resolvedTheme === resolvedTheme) {
      return snapshot;
    }

    preference = nextPreference;
    snapshot = freezeSnapshot(nextPreference, systemTheme, snapshot.revision + 1);
    environment.applyTheme(snapshot.resolvedTheme);
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== WEB_APPEARANCE_STORAGE_KEY) return;
    publish(event.key === null ? "light" : parseStoredPreference(event.newValue));
  };
  const onSystemChange = (event: MediaQueryListEvent) => {
    const nextSystemTheme = event.matches ? "dark" : "light";
    if (preference === "system") publish(preference, nextSystemTheme);
    else systemTheme = nextSystemTheme;
  };

  environment.storageEvents.addEventListener("storage", onStorage);
  environment.mediaQuery.addEventListener("change", onSystemChange);

  return {
    getSnapshot: () => snapshot,
    setPreference: async (nextPreference) => {
      const parsedPreference = parseThemePreference(nextPreference);
      const nextSnapshot = publish(parsedPreference);
      environment.storage.setItem(
        WEB_APPEARANCE_STORAGE_KEY,
        JSON.stringify({ version: 1, preference: parsedPreference }),
      );
      return nextSnapshot;
    },
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      environment.storageEvents.removeEventListener("storage", onStorage);
      environment.mediaQuery.removeEventListener("change", onSystemChange);
    },
  };
}

function createBrowserEnvironment(): WebAppearanceEnvironment {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("The Web appearance controller requires a browser document.");
  }

  const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? {
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  return {
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    mediaQuery,
    storageEvents: window,
    applyTheme: applyDocumentTheme,
  };
}

function readPreference(storage: Pick<Storage, "getItem">): ThemePreference {
  try {
    return parseStoredPreference(storage.getItem(WEB_APPEARANCE_STORAGE_KEY));
  } catch {
    return "light";
  }
}

function parseStoredPreference(value: string | null): ThemePreference {
  if (value === null) return "light";
  try {
    const record: unknown = JSON.parse(value);
    if (!isRecord(record) || record.version !== 1) return "light";
    return parseThemePreference(record.preference);
  } catch {
    return "light";
  }
}

function freezeSnapshot(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
  revision: number,
): AppearanceSnapshot {
  return Object.freeze({
    preference,
    resolvedTheme: resolveThemePreference(preference, systemTheme),
    revision,
  });
}

function applyDocumentTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.caelushTheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#181818" : "#ffffff");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
