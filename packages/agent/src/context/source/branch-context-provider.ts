import type { ContextSourceProvider } from "./context-source.js";
import { createSourceResult } from "./generic-provider-helpers.js";
import { AGENT_CONTEXT_SOURCE_IDS } from "./source-ids.js";

const PROVIDER_VERSION = "branch-context-noop-v1";

export function createBranchContextSourceProvider(): ContextSourceProvider {
  return Object.freeze({
    id: AGENT_CONTEXT_SOURCE_IDS.branchContext,
    async collect() {
      return createSourceResult(AGENT_CONTEXT_SOURCE_IDS.branchContext, PROVIDER_VERSION, []);
    },
  });
}
