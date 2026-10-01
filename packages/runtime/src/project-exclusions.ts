export const RUNTIME_HARD_EXCLUDED_DIRECTORY_NAMES = [
  ".git",
  ".hg",
  ".svn",
  ".worktrees",
  "node_modules",
  ".pnpm",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "vendor",
] as const;

export const RUNTIME_PROJECT_HARD_EXCLUDED_GLOBS = RUNTIME_HARD_EXCLUDED_DIRECTORY_NAMES.map(
  (name) => `**/${name}/**`,
);
