(() => {
  const storageKey = "caelush.appearance.v1";
  let preference = "light";

  try {
    const storedValue = window.localStorage.getItem(storageKey);
    if (storedValue !== null) {
      const stored = JSON.parse(storedValue);
      if (stored && stored.version === 1) {
        if (stored.preference === "dark" || stored.preference === "system") {
          preference = stored.preference;
        }
      }
    }
  } catch {
    preference = "light";
  }

  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  document.documentElement.dataset.caelushTheme = theme;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", theme === "dark" ? "#181818" : "#ffffff");
})();
