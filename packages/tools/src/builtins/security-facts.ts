import {
  assertToolSecurityFactsProjector,
  emptyToolSecurityFacts,
  projectApplyPatchSecurityFacts as canonicalProjectApplyPatchSecurityFacts,
  projectExecCommandSecurityFacts as canonicalProjectExecCommandSecurityFacts,
  projectFindFilesSecurityFacts as canonicalProjectFindFilesSecurityFacts,
  projectGitDiffSecurityFacts as canonicalProjectGitDiffSecurityFacts,
  projectGitStatusSecurityFacts as canonicalProjectGitStatusSecurityFacts,
  projectListDirectorySecurityFacts as canonicalProjectListDirectorySecurityFacts,
  projectReadFileSecurityFacts as canonicalProjectReadFileSecurityFacts,
  projectSearchTextSecurityFacts as canonicalProjectSearchTextSecurityFacts,
  projectWriteStdinSecurityFacts as canonicalProjectWriteStdinSecurityFacts,
  ToolSecurityFactsProjectionError,
} from "@caelush/coding-agent";
import type { JsonObject } from "@caelush/protocol";

import type { ToolSecurityFacts, ToolSecurityFactsProjector } from "../security-facts.js";

/**
 * Coding security facts projectors — a compatibility re-export, not a second implementation.
 *
 * ```text
 * @caelush/tools/src/builtins/security-facts.ts       this file: the compatibility surface
 *        └── re-exports ──▶  @caelush/coding-agent   tools/security/security-facts.ts
 *                                                     the canonical per-Tool projectors
 * ```
 *
 * Phase 4E moved the nine projectors to the Coding product layer, because a projector is **Coding
 * business knowledge**: it knows that `read_file` reads a path, that `apply_patch` must be parsed into
 * its targets before an input-aware decision can be made, and that `exec_command` carries a command, a
 * workdir and a tty. There is no path, command, patch, secret-scan or resource-access algorithm left in
 * `@caelush/tools`.
 *
 * ## Where production actually reads the projectors
 *
 * Nothing in production reads this module. The legacy builtin facades adapt a whole
 * `CodingToolDefinition` — its `securityFactsProjector` included — through `adapters.coding`, so the
 * admission path (`createCodingToolAdmissionPort`) calls the function `@caelush/coding-agent` built.
 * This module exists so an external caller that imported a projector by name keeps compiling through
 * Phase 4F, and so that name resolves to the canonical function rather than to a legacy one.
 *
 * ## The casts, and why they are confined here
 *
 * `ToolSecurityFacts` is declared twice — once over the Protocol JSON value model and once over the AI
 * one — because `@caelush/ai` may not depend on `@caelush/protocol`. The two describe the same JSON
 * value and differ only in how they are written, so a canonical projector is structurally the function
 * a legacy caller needs. This module is the single boundary where the two declarations meet.
 */
function bridge(
  projector: (args: Readonly<Record<string, unknown>>) => ToolSecurityFacts,
): ToolSecurityFactsProjector {
  return projector as unknown as ToolSecurityFactsProjector;
}

type CanonicalProjector = (args: Readonly<Record<string, unknown>>) => ToolSecurityFacts;

export const projectReadFileSecurityFacts = bridge(
  canonicalProjectReadFileSecurityFacts as unknown as CanonicalProjector,
);
export const projectListDirectorySecurityFacts = bridge(
  canonicalProjectListDirectorySecurityFacts as unknown as CanonicalProjector,
);
export const projectFindFilesSecurityFacts = bridge(
  canonicalProjectFindFilesSecurityFacts as unknown as CanonicalProjector,
);
export const projectSearchTextSecurityFacts = bridge(
  canonicalProjectSearchTextSecurityFacts as unknown as CanonicalProjector,
);
export const projectApplyPatchSecurityFacts = bridge(
  canonicalProjectApplyPatchSecurityFacts as unknown as CanonicalProjector,
);
export const projectExecCommandSecurityFacts = bridge(
  canonicalProjectExecCommandSecurityFacts as unknown as CanonicalProjector,
);
export const projectWriteStdinSecurityFacts = bridge(
  canonicalProjectWriteStdinSecurityFacts as unknown as CanonicalProjector,
);
export const projectGitStatusSecurityFacts = bridge(
  canonicalProjectGitStatusSecurityFacts as unknown as CanonicalProjector,
);
export const projectGitDiffSecurityFacts = bridge(
  canonicalProjectGitDiffSecurityFacts as unknown as CanonicalProjector,
);

export {
  assertToolSecurityFactsProjector,
  emptyToolSecurityFacts,
  ToolSecurityFactsProjectionError,
};
export type { JsonObject };
