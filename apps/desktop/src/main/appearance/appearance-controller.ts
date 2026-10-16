import {
  parseThemePreference,
  resolveThemePreference,
  type AppearanceSnapshot,
  type ResolvedTheme,
  type ThemePreference,
} from "@caelush/ui-theme";

export interface DesktopAppearanceNativeTheme {
  themeSource: ThemePreference;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): void;
  removeListener(event: "updated", listener: () => void): void;
}

export interface DesktopAppearanceStorePort {
  read(): Promise<ThemePreference>;
  write(preference: ThemePreference): Promise<void>;
}

export interface DesktopAppearanceControllerOptions {
  readonly store: DesktopAppearanceStorePort;
  readonly nativeTheme: DesktopAppearanceNativeTheme;
}

export class DesktopAppearanceController {
  private readonly listeners = new Set<(snapshot: AppearanceSnapshot) => void>();
  private preference: ThemePreference = "light";
  private systemTheme: ResolvedTheme = "light";
  private snapshot = freezeSnapshot("light", "light", 0);
  private writeTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  private readonly onNativeThemeUpdated = () => {
    if (this.disposed) return;
    this.systemTheme = this.options.nativeTheme.shouldUseDarkColors ? "dark" : "light";
    if (this.preference === "system") this.publish(this.preference, this.systemTheme);
  };

  constructor(private readonly options: DesktopAppearanceControllerOptions) {
    this.options.nativeTheme.on("updated", this.onNativeThemeUpdated);
  }

  async initialize(): Promise<AppearanceSnapshot> {
    if (this.disposed) throw new Error("Desktop appearance controller is disposed.");
    if (this.initialized) return this.snapshot;
    this.preference = parseThemePreference(await this.options.store.read());
    this.options.nativeTheme.themeSource = this.preference;
    this.systemTheme = this.options.nativeTheme.shouldUseDarkColors ? "dark" : "light";
    this.snapshot = freezeSnapshot(this.preference, this.systemTheme, 0);
    this.initialized = true;
    return this.snapshot;
  }

  getSnapshot(): AppearanceSnapshot {
    return this.snapshot;
  }

  setPreference(preference: ThemePreference): Promise<AppearanceSnapshot> {
    const parsedPreference = parseThemePreference(preference);
    const operation = this.writeTail.then(async () => {
      if (this.disposed) throw new Error("Desktop appearance controller is disposed.");
      if (!this.initialized) throw new Error("Desktop appearance controller is not initialized.");
      if (this.preference === parsedPreference) return this.snapshot;

      await this.options.store.write(parsedPreference);
      this.options.nativeTheme.themeSource = parsedPreference;
      this.systemTheme = this.options.nativeTheme.shouldUseDarkColors ? "dark" : "light";
      this.preference = parsedPreference;
      return this.publish(parsedPreference, this.systemTheme);
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.nativeTheme.removeListener("updated", this.onNativeThemeUpdated);
    this.listeners.clear();
  }

  private publish(preference: ThemePreference, systemTheme: ResolvedTheme): AppearanceSnapshot {
    const resolvedTheme = resolveThemePreference(preference, systemTheme);
    if (this.snapshot.preference === preference && this.snapshot.resolvedTheme === resolvedTheme) {
      return this.snapshot;
    }

    this.snapshot = freezeSnapshot(preference, systemTheme, this.snapshot.revision + 1);
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
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
