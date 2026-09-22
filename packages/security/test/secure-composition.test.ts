import { DefaultAgentToolRegistryBuilder, type AgentToolRegistry } from "@caelush/agent";
import {
  CodingToolCatalogBuilder,
  createDefaultCodingTools,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  DEFAULT_CODING_TOOL_ORDER,
  type CodingToolCatalog,
  type CodingToolDefinition,
  type DefaultCodingToolOperations,
} from "@caelush/coding-agent";
import { createLocalRuntimeResolver, LocalRuntime, type RuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import {
  V1SecurityCompositionError,
  assertDefaultBuiltinSecurityCoverage,
  createDefaultV1ToolExecutionSecurity,
} from "../src/index.js";

const identityTerminalSanitizer = (value: string): string => value;

/**
 * The nine default Coding Tools' Operations, built from one Runtime resolver.
 *
 * The audit is about *Security metadata coverage*, not about execution: every port here is the real
 * Runtime adapter, and none of them is called while the catalog is audited. Composing them this way is
 * what makes the audited registry the production one — a hand-written nine-Tool stub could claim a
 * coverage the real default catalog does not have.
 */
function defaultCodingOperations(resolver: RuntimeResolver): DefaultCodingToolOperations {
  const readOnly = createRuntimeReadOnlyOperations(resolver);
  return {
    readFile: readOnly,
    readOnly,
    patch: createRuntimePatchOperations(resolver),
    exec: createRuntimeProcessOperations(resolver),
    process: createRuntimeProcessOperations(resolver),
    git: createRuntimeGitOperations(resolver),
  };
}

/** The canonical registry: one builder, one `register(tool)` per Coding Tool, in catalog order. */
function buildRegistry(definitions: readonly CodingToolDefinition[]): AgentToolRegistry {
  const builder = new DefaultAgentToolRegistryBuilder();
  for (const definition of definitions) builder.register(definition.tool);
  return builder.build();
}

/** The canonical Coding overlay, aligned with the registry it has to describe. */
function buildCatalog(
  registry: AgentToolRegistry,
  definitions: readonly CodingToolDefinition[],
): CodingToolCatalog {
  const builder = new CodingToolCatalogBuilder().forRegistry(registry);
  for (const definition of definitions) builder.register(definition);
  return builder.build();
}

describe("default V1 security composition", () => {
  it("returns the real gate and sanitizer", () => {
    const security = createDefaultV1ToolExecutionSecurity({
      terminalOutputSanitizer: identityTerminalSanitizer,
    });
    expect(security.gate.constructor.name).toBe("CaelushToolExecutionGate");
    expect(security.presentation.constructor.name).toBe("CaelushToolPresentation");
    expect(security.resultSanitizer.constructor.name).toBe("CaelushToolResultSanitizer");
  });

  it("audits the actual default builtin catalog successfully", () => {
    const definitions = createDefaultCodingTools(
      defaultCodingOperations(createLocalRuntimeResolver(new LocalRuntime())),
    );
    const registry = buildRegistry(definitions);
    const catalog = buildCatalog(registry, definitions);

    // The audited catalogue is the real one: the nine default Tools, in the frozen order.
    expect(registry.modelSpecs().map((spec) => spec.name)).toEqual([...DEFAULT_CODING_TOOL_ORDER]);
    expect(catalog.size).toBe(DEFAULT_CODING_TOOL_ORDER.length);

    expect(() =>
      assertDefaultBuiltinSecurityCoverage(registry, catalog, DEFAULT_CODING_TOOL_ORDER),
    ).not.toThrow();
  });

  it("rejects a registry that cannot execute a default builtin", () => {
    // The original negative case: a host whose active registry never resolves `read_file`.
    const complete = createDefaultCodingTools(
      defaultCodingOperations(createLocalRuntimeResolver(new LocalRuntime())),
    );
    const definitions = complete.filter((definition) => definition.tool.name !== "read_file");
    const registry = buildRegistry(definitions);
    const catalog = buildCatalog(registry, definitions);

    expect(registry.has("read_file")).toBe(false);
    expect(() =>
      assertDefaultBuiltinSecurityCoverage(registry, catalog, DEFAULT_CODING_TOOL_ORDER),
    ).toThrow(V1SecurityCompositionError);
    expect(() =>
      assertDefaultBuiltinSecurityCoverage(registry, catalog, DEFAULT_CODING_TOOL_ORDER),
    ).toThrow("read_file");
  });

  it("rejects a default builtin whose catalog entry has no security-facts projector", () => {
    // The second half of the coverage rule: a Tool that reaches admission without facts is refused
    // there anyway, so a host that forgot the projector fails at composition instead of at runtime.
    const definitions = createDefaultCodingTools(
      defaultCodingOperations(createLocalRuntimeResolver(new LocalRuntime())),
    );
    const registry = buildRegistry(definitions);
    const withoutProjector = definitions.map((definition) =>
      definition.tool.name === "read_file"
        ? { ...definition, securityFactsProjector: undefined }
        : definition,
    );
    const catalog = buildCatalog(registry, withoutProjector);

    expect(registry.has("read_file")).toBe(true);
    expect(catalog.get("read_file")?.securityFactsProjector).toBeUndefined();
    expect(() =>
      assertDefaultBuiltinSecurityCoverage(registry, catalog, DEFAULT_CODING_TOOL_ORDER),
    ).toThrow(V1SecurityCompositionError);
    expect(() =>
      assertDefaultBuiltinSecurityCoverage(registry, catalog, DEFAULT_CODING_TOOL_ORDER),
    ).toThrow("read_file");
  });
});
