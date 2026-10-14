import { lstat } from "node:fs/promises";
import path from "node:path";

/** Validate the full path before touching generated output, including Windows junctions. */
export async function assertOwnedOutputPath(root, target) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Refusing to modify output outside its owned directory.");
  }
  const volume = path.parse(absoluteTarget).root;
  let current = volume;
  for (const segment of absoluteTarget.slice(volume.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("Refusing to modify output through a symbolic link or junction.");
    }
  }
  return absoluteTarget;
}
