import {
  parseThemePreference,
  type AppearanceController,
  type AppearanceSnapshot,
  type ResolvedTheme,
  type ThemePreference,
} from "@caelush/ui-theme";
import type { DesktopAppearanceBridge } from "./desktop-integration.js";

const LIGHT_SNAPSHOT: AppearanceSnapshot = Object.freeze({
  preference: "light",
  resolvedTheme: "light",
  revision: 0,
});

export function createDesktopAppearanceController(
  bridge: DesktopAppearanceBridge | undefined,
  applyTheme: (theme: ResolvedTheme) => void = applyDocumentTheme,
): AppearanceController {
  const listeners = new Set<(snapshot: AppearanceSnapshot) => void>();
  let committedSnapshot = bridge?.initialSnapshot ?? LIGHT_SNAPSHOT;
  let snapshot = committedSnapshot;
  let localRevision = snapshot.revision;
  let latestRequestId = 0;
  let pendingRequestId = 0;
  let disposed = false;

  applyTheme(snapshot.resolvedTheme);

  const publish = (
    preference: ThemePreference,
    resolvedTheme: ResolvedTheme,
    committedRevision?: number,
  ) => {
    if (
      committedRevision === undefined &&
      snapshot.preference === preference &&
      snapshot.resolvedTheme === resolvedTheme
    ) {
      return snapshot;
    }
    const revision = committedRevision ?? Math.max(localRevision + 1, committedSnapshot.revision);
    if (
      snapshot.preference === preference &&
      snapshot.resolvedTheme === resolvedTheme &&
      snapshot.revision === revision
    ) {
      return snapshot;
    }
    localRevision = Math.max(localRevision, revision);
    snapshot = Object.freeze({ preference, resolvedTheme, revision });
    applyTheme(snapshot.resolvedTheme);
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  const acceptCommitted = (candidate: unknown) => {
    if (
      disposed ||
      !isAppearanceSnapshot(candidate) ||
      candidate.revision < committedSnapshot.revision
    )
      return;
    committedSnapshot = Object.freeze({ ...candidate });
    localRevision = Math.max(localRevision, committedSnapshot.revision);
    if (pendingRequestId === 0)
      publish(
        committedSnapshot.preference,
        committedSnapshot.resolvedTheme,
        committedSnapshot.revision,
      );
  };

  const unsubscribe = bridge?.subscribe((next) => acceptCommitted(next)) ?? (() => undefined);
  void bridge
    ?.getSnapshot()
    .then(acceptCommitted)
    .catch(() => undefined);

  return {
    getSnapshot: () => snapshot,
    setPreference: async (preference) => {
      if (disposed) throw new Error("Desktop appearance controller is disposed.");
      if (bridge === undefined) {
        throw new Error("This Desktop version does not support appearance settings.");
      }

      const nextPreference = parseThemePreference(preference);
      const requestId = ++latestRequestId;
      pendingRequestId = requestId;
      publish(
        nextPreference,
        nextPreference === "system" ? committedSnapshot.resolvedTheme : nextPreference,
      );

      try {
        const acknowledgement = await bridge.setPreference(nextPreference);
        acceptCommitted(acknowledgement);
      } catch (error) {
        if (requestId === latestRequestId) await reconcile(requestId);
        throw error;
      }

      if (requestId === latestRequestId) await reconcile(requestId);
      return snapshot;
    },
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };

  async function reconcile(requestId: number): Promise<void> {
    if (bridge !== undefined) {
      try {
        acceptCommitted(await bridge.getSnapshot());
      } catch {
        // Retain the latest committed bridge snapshot if reconciliation is unavailable.
      }
    }
    if (requestId !== latestRequestId) return;
    pendingRequestId = 0;
    publish(committedSnapshot.preference, committedSnapshot.resolvedTheme);
  }
}

function applyDocumentTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.caelushTheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#181818" : "#ffffff");
}

function isAppearanceSnapshot(value: unknown): value is AppearanceSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.preference === "light" ||
      record.preference === "dark" ||
      record.preference === "system") &&
    (record.resolvedTheme === "light" || record.resolvedTheme === "dark") &&
    typeof record.revision === "number" &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 0
  );
}
