import path from "node:path";

function isWindowsAbsoluteLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const windowsLike =
    path.sep === "\\" || isWindowsAbsoluteLike(root) || isWindowsAbsoluteLike(candidate);
  const pathModule = windowsLike ? path.win32 : path.posix;
  const normalizedRoot = pathModule.normalize(root);
  const normalizedCandidate = pathModule.normalize(candidate);
  const relative = pathModule.relative(normalizedRoot, normalizedCandidate);
  return (
    relative === "" ||
    (!pathModule.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathModule.sep}`))
  );
}
