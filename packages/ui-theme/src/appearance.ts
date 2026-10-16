export type ThemePreference = "light" | "dark" | "system";

export type ResolvedTheme = "light" | "dark";

export interface AppearanceSnapshot {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly revision: number;
}

export interface AppearanceController {
  getSnapshot(): AppearanceSnapshot;
  setPreference(preference: ThemePreference): Promise<AppearanceSnapshot>;
  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void;
  dispose(): void;
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "dark" || value === "system" || value === "light" ? value : "light";
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}
