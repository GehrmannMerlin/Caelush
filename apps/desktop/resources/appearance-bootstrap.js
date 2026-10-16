/* global window, document */
(() => {
  const validSnapshot = (value) =>
    value !== null &&
    typeof value === "object" &&
    (value.preference === "light" ||
      value.preference === "dark" ||
      value.preference === "system") &&
    (value.resolvedTheme === "light" || value.resolvedTheme === "dark") &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0;

  let theme = "light";
  const desktopHost = window.caelushDesktop !== undefined;

  if (desktopHost) {
    const appearance = window.caelushDesktop?.appearance;
    const snapshot = appearance?.capabilityVersion === 1 ? appearance.initialSnapshot : undefined;
    if (validSnapshot(snapshot)) {
      theme = snapshot.resolvedTheme;
    }
  } else {
    let preference = "light";
    try {
      const storedValue = window.localStorage.getItem("caelush.appearance.v1");
      if (storedValue !== null) {
        const stored = JSON.parse(storedValue);
        if (stored?.version === 1) {
          if (stored.preference === "dark" || stored.preference === "system") {
            preference = stored.preference;
          }
        }
      }
    } catch {
      // The light default remains active when browser storage is unavailable.
    }

    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  }

  document.documentElement.dataset.caelushTheme = theme;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", theme === "dark" ? "#181818" : "#ffffff");
})();
