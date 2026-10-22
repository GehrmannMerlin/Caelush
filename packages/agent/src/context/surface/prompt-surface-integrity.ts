import { createHash } from "node:crypto";

export class PromptSurfaceIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PromptSurfaceIntegrityError";
  }
}

/** A provider rejected this Step's prior Context, so a bounded recovery may reproject it. */
export class PromptSurfaceStepRetryConflictError extends PromptSurfaceIntegrityError {
  constructor() {
    super("Prompt Surface Step retry differs from its durable Section decision.");
    this.name = "PromptSurfaceStepRetryConflictError";
  }
}

export function hashPromptSurfaceContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
