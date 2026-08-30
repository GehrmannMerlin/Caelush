import { parsePatch } from "./parser.js";
import type { PatchOperation } from "./types.js";

export interface PatchInspectionTarget {
  readonly operation: "WRITE" | "DELETE" | "MOVE";
  readonly path: string;
  readonly fromPath?: string;
  readonly toPath?: string;
}

export function inspectPatchTargets(patch: string): readonly PatchInspectionTarget[] {
  return parsePatch(patch).operations.flatMap((operation) => inspectOperation(operation));
}

function inspectOperation(operation: PatchOperation): readonly PatchInspectionTarget[] {
  if (operation.kind === "ADD" || operation.kind === "UPDATE") {
    if (operation.kind === "UPDATE" && operation.moveTo !== undefined) {
      return [
        {
          operation: "MOVE",
          path: operation.path,
          fromPath: operation.path,
          toPath: operation.moveTo,
        },
      ];
    }
    return [{ operation: "WRITE", path: operation.path }];
  }
  return [{ operation: "DELETE", path: operation.path }];
}
