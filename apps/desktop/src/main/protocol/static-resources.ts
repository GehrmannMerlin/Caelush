import { realpath } from "node:fs/promises";
import path from "node:path";

export async function resolveStaticFile(
  rendererRoot: string,
  requestPath: string,
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(":")))
    return null;
  const rootSegments = segments.filter(Boolean);
  const root = path.resolve(rendererRoot);
  const target =
    rootSegments.length === 0 ? path.join(root, "index.html") : path.join(root, ...rootSegments);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  try {
    const realRoot = await realpath(root);
    const realTarget = await realpath(target);
    const realRelative = path.relative(realRoot, realTarget);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    )
      return null;
    return realTarget;
  } catch {
    return null;
  }
}
