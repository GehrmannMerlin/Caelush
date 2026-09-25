import { createContextSourceId, type ContextSourceId } from "@caelush/agent";

export const CODING_CONTEXT_SOURCE_IDS = Object.freeze({
  workspace: createContextSourceId("coding.workspace"),
  runtimeFacts: createContextSourceId("coding.runtime-facts"),
  projectInstructions: createContextSourceId("coding.project-instructions"),
  projectMetadata: createContextSourceId("coding.project-metadata"),
  relevantFiles: createContextSourceId("coding.relevant-files"),
  skillCatalog: createContextSourceId("coding.skill-catalog"),
  gitState: createContextSourceId("coding.git-state"),
  verificationRepair: createContextSourceId("coding.verification-repair"),
  temporal: createContextSourceId("coding.temporal"),
} satisfies Readonly<{
  readonly workspace: ContextSourceId;
  readonly runtimeFacts: ContextSourceId;
  readonly projectInstructions: ContextSourceId;
  readonly projectMetadata: ContextSourceId;
  readonly relevantFiles: ContextSourceId;
  readonly skillCatalog: ContextSourceId;
  readonly gitState: ContextSourceId;
  readonly verificationRepair: ContextSourceId;
  readonly temporal: ContextSourceId;
}>);
