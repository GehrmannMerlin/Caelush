import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const distributionDirectory = join(packageDirectory, "dist");

await mkdir(distributionDirectory, { recursive: true });
await cp(join(packageDirectory, "src", "styles"), join(distributionDirectory, "styles"), {
  recursive: true,
  force: true,
});
await cp(join(packageDirectory, "assets"), join(distributionDirectory, "assets"), {
  recursive: true,
  force: true,
});
