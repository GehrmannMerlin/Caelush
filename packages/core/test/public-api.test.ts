import type { AIToolSpec } from "@caelush/ai";
import * as core from "../src/index.js";
import type { ToolTurnPipeline } from "../src/index.js";
import { describe, expect, it } from "vitest";

/**
 * The model-facing Tool catalog Core exposes to a host.
 *
 * `ToolTurnPipeline` is the exported Run Layer boundary a host composes, and Phase 4F replaced its
 * `modelDefinitions(): readonly ToolDefinition[]` with `modelSpecs(): readonly AIToolSpec[]` when
 * `protocol.ToolDefinition` was retired: the registry now stores the model-facing spec, so Core passes
 * that value through instead of projecting a seven-field description into it.
 */
type ToolCatalogSpecs = ReturnType<ToolTurnPipeline["modelSpecs"]>;

describe("Core Phase 6B public API", () => {
  it("exports the required Kernel contracts and helpers", () => {
    const required = [
      "AgentModelOutputError",
      "AgentToolResultBatchError",
      "AgentKernelStateError",
      "classifyAgentDecision",
      "normalizeToolResultBatch",
      "toAIToolResultMessages",
      "summarizeAgentDecision",
      "summarizeAgentLoopOutcome",
      "createInitialAgentState",
      "startAgentState",
      "beginAgentStepState",
      "settleAgentStepState",
      "markAgentStateVerifying",
      "markAgentStateMaxStepsReached",
      "markAgentStateWaitingApproval",
      "createRunningAgentStep",
      "completeAgentStep",
      "failAgentStep",
      "cancelAgentStep",
      "evaluateAgentStepGate",
      "nextAgentStepSequence",
    ];
    for (const name of required) {
      expect(core, name).toHaveProperty(name);
    }
  });

  it("does not expose the retired Core AgentLoop facade", () => {
    expect((core as Record<string, unknown>).AgentLoop).toBeUndefined();
    expect((core as Record<string, unknown>).runAgentLoop).toBeUndefined();
  });

  it("exposes the canonical model-facing Tool catalog on its Tool turn boundary", () => {
    // This declaration is the assertion: a retired seven-field `ToolDefinition` is not assignable
    // from an `AIToolSpec`, so the assignment below only compiles while `modelSpecs()` answers with
    // the registry's own three-field contract.
    const specs: ToolCatalogSpecs = [] as readonly AIToolSpec[];
    expect(specs).toEqual([]);
    expect(specs.length).toBe(0);
  });

  it("no longer exposes the retired model-Tool projection", () => {
    // The runtime value is trivially absent; the assertion that matters is the type error the
    // directive above suppresses. If `modelDefinitions()` ever resolves as a member of the exported
    // boundary again, `tsc -p tsconfig.json --noEmit` fails on a now-unused directive.
    // @ts-expect-error `modelDefinitions()` was retired with `protocol.ToolDefinition` in Phase 4F.
    const retired: unknown = ({} as ToolTurnPipeline).modelDefinitions;
    expect(retired).toBeUndefined();
  });
});
