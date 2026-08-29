import { LocalRuntime, createLocalRuntimeResolver, type RuntimeResolver } from "@caelush/runtime";
import type { ToolRegistration } from "../registration.js";
import { createFindFilesRegistration } from "./find-files.js";
import { createListDirectoryRegistration } from "./list-directory.js";
import { createReadFileRegistration } from "./read-file.js";
import { createSearchTextRegistration } from "./search-text.js";

export function createReadOnlyFilesystemToolRegistrations(
  runtimeResolver: RuntimeResolver = createLocalRuntimeResolver(new LocalRuntime()),
): readonly ToolRegistration[] {
  return [
    createReadFileRegistration(runtimeResolver),
    createListDirectoryRegistration(runtimeResolver),
    createFindFilesRegistration(runtimeResolver),
    createSearchTextRegistration(runtimeResolver),
  ];
}
