import type { JsonObject, ToolName } from "@caelush/protocol";

export type ToolResourceOperation = "READ" | "WRITE" | "DELETE" | "MOVE" | "SEARCH" | "DIFF";

export interface ToolResourceAccess {
  readonly operation: ToolResourceOperation;
  readonly path: string;
}

export interface ToolShellCommandFact {
  readonly command: string;
  readonly workdir: string;
  readonly tty: boolean;
}

export interface ToolSecretScanInput {
  readonly kind: "COMMAND" | "STDIN" | "PATCH" | "GENERIC";
  readonly text: string;
}

export interface ToolSecurityFacts {
  readonly resourceAccesses: readonly ToolResourceAccess[];
  readonly shellCommand?: ToolShellCommandFact;
  readonly secretScanInputs: readonly ToolSecretScanInput[];
  readonly structuralPreview?: JsonObject;
}

export type ToolSecurityFactsProjector = (args: Readonly<JsonObject>) => ToolSecurityFacts;

export class ToolSecurityFactsProjectionError extends Error {
  constructor(message = "Tool security facts could not be projected safely.") {
    super(message);
    this.name = "ToolSecurityFactsProjectionError";
  }
}

export function emptyToolSecurityFacts(): ToolSecurityFacts {
  return { resourceAccesses: [], secretScanInputs: [] };
}

export function assertToolSecurityFactsProjector(
  value: unknown,
): asserts value is ToolSecurityFactsProjector {
  if (typeof value !== "function") throw new TypeError("Tool security facts projector is invalid.");
}

export type ToolSecurityFactToolName = ToolName;
