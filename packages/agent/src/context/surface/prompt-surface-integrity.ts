import { createHash } from "node:crypto";

export class PromptSurfaceIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PromptSurfaceIntegrityError";
  }
}

export function hashPromptSurfaceContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
