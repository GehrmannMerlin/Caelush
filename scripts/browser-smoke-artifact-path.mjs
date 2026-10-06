import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve a prompt-cache screenshot directory and require its actual destination to be external. */
export async function resolvePromptCacheArtifactDirectory(
  repositoryDirectory,
  configuredDirectory,
) {
  if (configuredDirectory === undefined) {
    throw new Error(
      "The prompt-cache browser smoke requires an artifact directory outside the repository.",
    );
  }

  const repositoryRoot = await realpath(repositoryDirectory);
  const artifactDirectory = await resolveThroughExistingAncestor(configuredDirectory);
  const relativeArtifactDirectory = relative(repositoryRoot, artifactDirectory);
  const isInsideRepository =
    relativeArtifactDirectory === "" ||
    (!isAbsolute(relativeArtifactDirectory) &&
      relativeArtifactDirectory !== ".." &&
      !relativeArtifactDirectory.startsWith(`..${sep}`));
  if (isInsideRepository) {
    throw new Error(
      "The prompt-cache browser smoke requires an artifact directory outside the repository.",
    );
  }

  return artifactDirectory;
}

async function resolveThroughExistingAncestor(targetPath) {
  let currentPath = resolve(targetPath);
  const missingSegments = [];
  for (;;) {
    try {
      return resolve(await realpath(currentPath), ...missingSegments);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) throw error;
      missingSegments.unshift(basename(currentPath));
      currentPath = parentPath;
    }
  }
}
