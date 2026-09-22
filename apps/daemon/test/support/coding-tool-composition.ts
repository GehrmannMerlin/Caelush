import {
  CodingToolCatalogBuilder,
  createDefaultCodingTools,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  GIT_TOOL_NAMES,
  type CodingToolCatalog,
  type CodingToolDefinition,
  type DefaultCodingToolOperations,
  type GitToolAvailability,
} from "@caelush/coding-agent";
import { DefaultAgentToolRegistryBuilder, type AgentToolRegistry } from "@caelush/agent";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";

/**
 * The production Coding Tool composition, built the way `apps/daemon/src/daemon-composition.ts` builds
 * it.
 *
 * ```text
 * RuntimeResolver
 *   → the four Runtime Operations adapters      @caelush/coding-agent
 *   → createDefaultCodingTools(...)             the nine Coding Tool definitions
 *   → DefaultAgentToolRegistryBuilder           the canonical AgentToolRegistry
 *   → CodingToolCatalogBuilder.forRegistry      the Coding overlay, aligned to that registry
 * ```
 *
 * The composition root's own helpers are private, so a daemon test that wants the real objects rather
 * than a private copy of them mirrors the same four steps. Nothing is reimplemented here: every value
 * is produced by the canonical factory that owns it, which is what makes an assertion about this
 * fixture an assertion about production.
 *
 * Git exposure fails closed exactly as production fails it: the reduced *definition* list is derived
 * before anything is built, so the registry, the catalog and the model specs always describe the same
 * active set.
 */
export interface CodingToolComposition {
  readonly runtime: LocalRuntime;
  readonly runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>;
  readonly definitions: readonly CodingToolDefinition[];
  readonly registry: AgentToolRegistry;
  readonly catalog: CodingToolCatalog;
}

export function createCodingToolComposition(
  options: {
    readonly runtime?: LocalRuntime;
    readonly toolExposure?: GitToolAvailability;
    readonly definitions?: readonly CodingToolDefinition[];
  } = {},
): CodingToolComposition {
  const runtime = options.runtime ?? new LocalRuntime();
  const runtimeResolver = createLocalRuntimeResolver(runtime);
  const definitions =
    options.definitions ??
    defaultCodingToolSet(
      defaultCodingOperations(runtimeResolver),
      options.toolExposure ?? "AVAILABLE",
    );
  const registry = buildCodingToolRegistry(definitions);
  return Object.freeze({
    runtime,
    runtimeResolver,
    definitions,
    registry,
    catalog: buildCodingToolCatalog(registry, definitions),
  });
}

/**
 * The four Runtime Operations adapters, as the one bundle `createDefaultCodingTools` expects.
 *
 * This is the only place a test holds a `RuntimeResolver` for a Coding Tool: the Tools themselves
 * receive narrow ports, so a `read_file` implementation cannot reach `git` and a `git_status`
 * implementation cannot reach the filesystem.
 */
export function defaultCodingOperations(
  runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>,
): DefaultCodingToolOperations {
  const readOnly = createRuntimeReadOnlyOperations(runtimeResolver);
  return {
    readFile: readOnly,
    readOnly,
    patch: createRuntimePatchOperations(runtimeResolver),
    exec: createRuntimeProcessOperations(runtimeResolver),
    process: createRuntimeProcessOperations(runtimeResolver),
    git: createRuntimeGitOperations(runtimeResolver),
  };
}

/** The default Coding Tool set for a known environment. `UNKNOWN` fails closed, like production. */
export function defaultCodingToolSet(
  operations: DefaultCodingToolOperations,
  environment: GitToolAvailability,
): readonly CodingToolDefinition[] {
  const definitions = createDefaultCodingTools(operations);
  if (environment === "AVAILABLE") return definitions;
  const excluded = new Set<string>(GIT_TOOL_NAMES);
  return Object.freeze(definitions.filter((definition) => !excluded.has(definition.tool.name)));
}

/**
 * Build one immutable canonical Tool registry from Coding Tool definitions.
 *
 * The registry receives the **executable Tool**, not the overlay: the Agent Tool Layer may not learn
 * what risk level, capability or prompt snippet a Coding Tool carries.
 */
export function buildCodingToolRegistry(
  definitions: readonly CodingToolDefinition[],
): AgentToolRegistry {
  const builder = new DefaultAgentToolRegistryBuilder();
  for (const definition of definitions) builder.register(definition.tool);
  return builder.build();
}

/**
 * Build the Coding overlay for the Tools a registry actually carries.
 *
 * `forRegistry()` is the alignment step: it refuses any entry whose Tool the registry cannot execute,
 * so Coding metadata can never describe a call that cannot happen.
 */
export function buildCodingToolCatalog(
  registry: AgentToolRegistry,
  definitions: readonly CodingToolDefinition[],
): CodingToolCatalog {
  const builder = new CodingToolCatalogBuilder().forRegistry(registry);
  for (const definition of definitions) builder.register(definition);
  return builder.build();
}
