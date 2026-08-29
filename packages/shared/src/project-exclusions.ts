export const PROJECT_HARD_EXCLUDED_DIRECTORY_NAMES = [
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

export const PROJECT_HARD_EXCLUDED_GLOBS = PROJECT_HARD_EXCLUDED_DIRECTORY_NAMES.map(
  (name) => `**/${name}/**`,
);

export function isProjectHardExcludedDirectoryName(name: string): boolean {
  return PROJECT_HARD_EXCLUDED_DIRECTORY_NAMES.includes(
    name.toLowerCase() as (typeof PROJECT_HARD_EXCLUDED_DIRECTORY_NAMES)[number],
  );
}
