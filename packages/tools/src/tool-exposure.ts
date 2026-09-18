import type { ToolName } from "@caelush/protocol";

import { ToolRegistryBuilder } from "./registry-builder.js";
import type { ToolRegistry } from "./registry.js";

export type GitToolAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";

export interface ToolExposureEnvironment {
  readonly git: GitToolAvailability;
}

const GIT_TOOLS = new Set<ToolName>(["git_status", "git_diff"]);

/**
 * Creates one immutable registry for the known environment.
 *
 * Unknown Git capability fails closed, keeping model definitions and executable handlers on the same
 * filtered registry — and, because the rebuild goes through the canonical `ToolRegistryBuilder` and
 * re-projects each entry's Coding metadata, the filtered **Catalog** stays aligned with the filtered
 * registry. A Tool that was filtered out has no overlay entry left behind for a later reader to
 * re-register without its policy.
 *
 * The filter re-registers canonical entries and re-validates them; it never resolves or compiles on
 * its own.
 */
export function filterToolRegistryForEnvironment(
  registry: ToolRegistry,
  environment: ToolExposureEnvironment,
): ToolRegistry {
  const builder = new ToolRegistryBuilder();
  for (const name of registry.names()) {
    if (GIT_TOOLS.has(name) && environment.git !== "AVAILABLE") continue;
    const resolved = registry.resolve(name);
    if (resolved === undefined || resolved.agentTool === undefined) {
      throw new Error(`Tool registry lost active tool ${name}.`);
    }
    builder.register({
      definition: resolved.definition,
      handler: resolved.handler,
      ...(resolved.effectProjector === undefined
        ? {}
        : { effectProjector: resolved.effectProjector }),
      ...(resolved.securityFactsProjector === undefined
        ? {}
        : { securityFactsProjector: resolved.securityFactsProjector }),
      ...(resolved.modelGuidance === undefined ? {} : { modelGuidance: resolved.modelGuidance }),
      adapters: {
        agent: resolved.agentTool,
        ...(resolved.coding === undefined ? {} : { coding: resolved.coding }),
      },
    });
  }
  return builder.build();
}
