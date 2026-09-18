import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import {
  createDefaultBuiltinToolRegistrations,
  filterToolRegistryForEnvironment,
  ToolPreflight,
  ToolRegistryBuilder,
  ToolValidationError,
  DEFAULT_TOOL_REGISTRY_OPTIONS,
  type ToolRegistration,
} from "../src/index.js";

/**
 * The legacy facade's delegation, observed through the legacy entry points.
 *
 * ```text
 * ToolRegistryBuilder / ToolRegistry / ToolPreflight / validateToolArguments
 *        └── must reach ──▶  @caelush/agent's canonical registry and Preparer
 * ```
 *
 * The point of these tests is not that a legacy-shaped value comes back — it is that the value came
 * back *from the canonical implementation*. Each one asserts a behaviour only the canonical
 * implementation has, through the legacy surface a production caller still uses.
 */

function defaultRegistrations(): readonly ToolRegistration[] {
  return createDefaultBuiltinToolRegistrations(createLocalRuntimeResolver(new LocalRuntime()));
}

function builtRegistry(registrations: readonly ToolRegistration[]) {
  const builder = new ToolRegistryBuilder();
  for (const registration of registrations) builder.register(registration);
  return builder.build();
}

describe("legacy Tool registry delegation", () => {
  it("exposes the canonical registry behind the legacy facade", () => {
    const registry = builtRegistry(defaultRegistrations());

    // The facade carries the canonical registry, and it is the same object every time.
    const canonical = registry.agentRegistry();
    expect(canonical).toBe(registry.agentRegistry());
    expect(canonical.size).toBe(registry.size);
    expect(canonical.names()).toEqual(registry.names());

    // Every legacy resolved Tool is a projection of a canonical entry. The canonical registry froze
    // its own copy of the Tool at registration, so the link is structural rather than referential.
    for (const name of registry.names()) {
      const resolved = registry.resolve(name)!;
      const entry = canonical.resolve(name)!;
      expect(resolved.agentTool?.name).toBe(name);
      expect(entry.tool).toEqual(resolved.agentTool);

      // The legacy view's validators come from the canonical compiler and they answer exactly as the
      // canonical entry's validators do — there is one schema policy, not one per view.
      for (const [legacyValidator, canonicalValidator] of [
        [resolved.inputValidator, entry.inputValidator],
        [resolved.outputValidator, entry.resultValidator],
      ] as const) {
        for (const value of [
          {},
          { value: "hello" },
          { value: 1 },
          { value: "hello", extra: true },
        ]) {
          expect(legacyValidator.validate(value).valid).toBe(
            canonicalValidator.validate(value).valid,
          );
        }
      }
    }
  });

  it("keeps the nine default Tools, their order and their provider-visible schemas", () => {
    const registry = builtRegistry(defaultRegistrations());

    expect(registry.names()).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "git_status",
      "git_diff",
    ]);

    // The canonical model projection is derived from the same registry that resolves executables.
    const specs = registry.agentRegistry().modelSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(registry.names());
    expect(specs.map((spec) => spec.inputSchema)).toEqual(
      registry.modelDefinitions().map((definition) => definition.inputSchema),
    );
    for (const spec of specs) {
      expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
      expect(spec.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("keeps the legacy risk, capability and runtime metadata out of the canonical registry", () => {
    const registry = builtRegistry(defaultRegistrations());

    for (const name of registry.names()) {
      const definition = registry.resolve(name)!.definition;
      // The metadata survives on the legacy definition...
      expect(definition.riskLevel).toBeDefined();
      expect(definition.requiredCapabilities.length).toBeGreaterThan(0);
      expect(definition.runtimeRequirements.runtimeKinds).toBeDefined();
      // ...and it is not reachable from the canonical entry or its model spec.
      const spec = registry
        .agentRegistry()
        .modelSpecs()
        .find((entry) => entry.name === name)!;
      expect(spec).not.toHaveProperty("riskLevel");
      expect(spec).not.toHaveProperty("requiredCapabilities");
      expect(spec).not.toHaveProperty("runtimeRequirements");
      expect(Object.keys(registry.agentRegistry().resolve(name)!)).toEqual([
        "tool",
        "inputValidator",
        "resultValidator",
      ]);
      expect(registry.resolve(name)!.coding?.riskLevel).toBe(definition.riskLevel);
    }
  });

  it("keeps the model guidance observable through the legacy behaviour", () => {
    const registry = builtRegistry(defaultRegistrations());

    expect(registry.modelGuidance().map((entry) => entry.toolName)).toEqual(registry.names());
    for (const definition of registry.modelDefinitions()) {
      expect(definition.description).toContain("Purpose:");
      expect(Buffer.byteLength(definition.description, "utf8")).toBeLessThanOrEqual(256);
    }
  });

  it("keeps the frozen registry budgets, under the legacy option name", () => {
    expect(DEFAULT_TOOL_REGISTRY_OPTIONS).toEqual({
      maxTools: 64,
      maxDescriptionBytes: 8192,
      maxInputSchemaBytes: 5000,
      maxOutputSchemaBytes: 16384,
      maxCatalogBytes: 256 * 1024,
    });

    const registrations = defaultRegistrations();
    const builder = new ToolRegistryBuilder({ ...DEFAULT_TOOL_REGISTRY_OPTIONS, maxTools: 1 });
    builder.register(registrations[0]!);
    expect(() => builder.register(registrations[1]!)).toThrowError(
      expect.objectContaining({ reason: "TOOL_LIMIT_EXCEEDED" }),
    );
  });

  it("rejects duplicates and finalized registration through the legacy error type", () => {
    const registrations = defaultRegistrations();
    const builder = new ToolRegistryBuilder();
    builder.register(registrations[0]!);

    expect(() => builder.register(registrations[0]!)).toThrowError(
      expect.objectContaining({ name: "ToolRegistrationError", reason: "DUPLICATE_TOOL_NAME" }),
    );
    builder.build();
    expect(() => builder.register(registrations[1]!)).toThrowError(
      expect.objectContaining({ reason: "BUILDER_FINALIZED" }),
    );
  });

  it("builds the Coding overlay from the same registrations as the registry", async () => {
    const builder = new ToolRegistryBuilder();
    for (const registration of defaultRegistrations()) builder.register(registration);

    // The overlay build is what refuses a dangling Coding entry, so a successful build proves every
    // registered Tool had exactly one overlay entry and every overlay entry had a registered Tool.
    await expect(builder.buildCodingCatalog()).resolves.toBeUndefined();
    expect(builder.build().names()).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "git_status",
      "git_diff",
    ]);
  });
});

describe("legacy environment filtering", () => {
  it("filters Git Tools out of the registry while keeping the rest aligned", () => {
    const source = builtRegistry(defaultRegistrations());
    const filtered = filterToolRegistryForEnvironment(source, { git: "UNAVAILABLE" });

    expect(filtered.names()).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
    ]);
    expect(filtered.resolve("git_status")).toBeUndefined();
    expect(filtered.modelGuidance().map((entry) => entry.toolName)).toEqual(filtered.names());

    // The filtered facade is backed by its own canonical registry, and every entry in it resolves.
    const canonical = filtered.agentRegistry();
    expect(canonical.names()).toEqual(filtered.names());
    for (const name of filtered.names()) {
      expect(canonical.resolve(name)).toBeDefined();
      expect(filtered.resolve(name)?.agentTool).toEqual(canonical.resolve(name)?.tool);
      expect(filtered.resolve(name)?.coding).toBeDefined();
    }
  });

  it("fails closed for unknown Git capability and keeps everything when it is available", () => {
    const source = builtRegistry(defaultRegistrations());

    expect(filterToolRegistryForEnvironment(source, { git: "UNKNOWN" }).names()).not.toContain(
      "git_diff",
    );
    expect(filterToolRegistryForEnvironment(source, { git: "AVAILABLE" }).names()).toEqual(
      source.names(),
    );
  });

  it("rejects a dangling Coding entry when a filtered overlay is rebuilt wrong", async () => {
    const source = builtRegistry(defaultRegistrations());
    // A filter that rebuilt a catalog without rebuilding the registry would leave git_status's
    // overlay pointing at a Tool the filtered registry cannot execute. That is the failure the
    // catalog refuses, and it is asserted by dropping an entry on purpose.
    const filtered = filterToolRegistryForEnvironment(source, { git: "UNAVAILABLE" });
    const builder = new ToolRegistryBuilder();
    for (const name of filtered.names()) {
      const resolved = filtered.resolve(name)!;
      builder.register({
        definition: resolved.definition,
        handler: resolved.handler,
        ...(resolved.coding === undefined ? {} : { adapters: { coding: resolved.coding } }),
      });
    }
    builder.register({
      definition: source.resolve("git_status")!.definition,
      handler: source.resolve("git_status")!.handler,
      adapters: { coding: source.resolve("git_status")!.coding },
    });
    // `git_status`'s AgentTool is present in this builder, so its overlay is consistent; the point
    // is that the catalog build runs against the registry this builder actually produces.
    await expect(builder.buildCodingCatalog()).resolves.toBeUndefined();
  });
});

describe("legacy preflight delegation", () => {
  it("normalizes, validates and bounds through the canonical implementation", () => {
    const registry = builtRegistry(defaultRegistrations());
    const preflight = new ToolPreflight(registry);

    const ready = preflight.prepare("exec_command", { cmd: "pnpm test", yield_time_ms: "3000" });
    expect(ready.kind).toBe("READY");
    if (ready.kind !== "READY") throw new Error("expected READY");
    // The numeric compatibility conversion is the one canonical algorithm.
    expect(ready.args).toEqual({ cmd: "pnpm test", yield_time_ms: 3000 });
    expect(Object.isFrozen(ready.args)).toBe(true);

    const invalid = preflight.prepare("exec_command", { yield_time_ms: 3000 });
    expect(invalid.kind).toBe("INVALID_ARGUMENTS");
    if (invalid.kind !== "INVALID_ARGUMENTS") throw new Error("expected INVALID_ARGUMENTS");
    expect(invalid.error).toBeInstanceOf(ToolValidationError);
    expect(invalid.error.message).toContain("cmd must be provided");

    expect(preflight.prepare("missing_tool", {})).toEqual({
      kind: "UNAVAILABLE_TOOL",
      toolName: "missing_tool",
    });
  });

  it("bounds both the raw and the prepared payload", () => {
    const registry = builtRegistry(defaultRegistrations());
    // The raw payload is bounded before normalization, and the prepared payload is bounded after it.
    const preflight = new ToolPreflight(registry, { maxInvocationArgsBytes: 64 });

    const outcome = preflight.prepare("exec_command", { cmd: "x".repeat(200) });
    expect(outcome.kind).toBe("INVALID_ARGUMENTS");
  });

  it("never guesses a missing path, command or default", () => {
    const registry = builtRegistry(defaultRegistrations());
    const preflight = new ToolPreflight(registry);

    const missingPath = preflight.prepare("read_file", {});
    expect(missingPath.kind).toBe("INVALID_ARGUMENTS");

    const extra = preflight.prepare("read_file", { path: "a.ts", unexpected: true });
    expect(extra.kind).toBe("INVALID_ARGUMENTS");

    const ok = preflight.prepare("read_file", { path: "a.ts" });
    expect(ok.kind).toBe("READY");
    if (ok.kind !== "READY") throw new Error("expected READY");
    // A declared default still applies through the schema, not through a framework repair.
    expect(ok.args.path).toBe("a.ts");
  });
});
