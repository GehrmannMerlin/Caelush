/**
 * Caelush Architecture V2 dependency rules.
 *
 * This module is the machine-readable form of the frozen Architecture V2
 * dependency matrix. It contains no scanner logic and no baseline logic so the
 * rule matrix can be reviewed as pure data.
 *
 * Identity model
 * --------------
 * Every workspace project has a stable "package identity" derived from its
 * package.json `name` (the `caelush` scope is stripped). The legacy packages
 * keep their legacy identity (`core`, `llm`, `shared`, ...) because Phase 1A
 * must not re-identify them. Architecture V2 target packages use their final
 * identity (`ai`, `agent`, `coding-agent`, ...).
 *
 * @typedef {"source-import" | "package-manifest"} ViolationKind
 * @typedef {{
 *   id: string,
 *   kind: ViolationKind,
 *   from: string,
 *   to: string,
 *   description: string,
 * }} DependencyRule
 */

/** Workspace dependency fields that participate in the package dependency graph. */
export const MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** The scope prefix that marks a Caelush workspace dependency. */
export const CAELUSH_SCOPE = "@caelush/";

/**
 * Allowed direction of the Architecture V2 target graph, for documentation and
 * for the human-readable boundary document. The rule list below is the
 * authoritative machine form; this table must stay consistent with it.
 */
export const V2_ALLOWED_DEPENDENCIES = /** @type {Record<string, readonly string[]>} */ ({
  ai: [],
  protocol: [],
  runtime: [],
  storage: [],
  agent: [],
  "coding-agent": ["ai", "protocol", "agent", "runtime"],
  client: ["protocol"],
});

/** Architecture V2 packages that must exist once migration completes. */
export const V2_TARGET_PACKAGES = [
  "ai",
  "protocol",
  "agent",
  "runtime",
  "coding-agent",
  "storage",
  "client",
];

/** Architecture V2 host applications. */
export const V2_HOST_APPS = ["daemon", "cli", "web", "launcher"];

/** Architecture V2 packages that Phase 1A does not create. */
export const V2_PHASE_1A_DEFERRED_PACKAGES = ["protocol", "runtime", "storage", "client"];

/** Architecture V2 packages that Phase 1A creates as empty skeletons. */
export const V2_PHASE_1A_CREATED_PACKAGES = ["ai", "agent", "coding-agent"];

/**
 * @param {string} from
 * @param {string} to
 * @param {ViolationKind} kind
 * @returns {DependencyRule}
 */
function rule(from, to, kind) {
  const suffix = kind === "source-import" ? "MUST_NOT_DEPEND_ON" : "MUST_NOT_DECLARE_DEPENDENCY_ON";
  const id = `${from.toUpperCase().replaceAll("-", "_")}_${suffix}_${to
    .toUpperCase()
    .replaceAll("-", "_")}`;

  return {
    id,
    kind,
    from,
    to,
    description:
      kind === "source-import"
        ? `@caelush/${from} must not import @caelush/${to} from source`
        : `@caelush/${from} must not declare a workspace dependency on @caelush/${to}`,
  };
}

/** @type {DependencyRule[]} */
export const DEPENDENCY_RULES = [
  // @caelush/ai — model/provider/API layer. It knows nothing above it.
  rule("ai", "agent", "source-import"),
  rule("ai", "coding-agent", "source-import"),
  rule("ai", "runtime", "source-import"),
  rule("ai", "storage", "source-import"),
  rule("ai", "client", "source-import"),

  // @caelush/protocol — cross-process contract. It knows no implementation.
  rule("protocol", "agent", "source-import"),
  rule("protocol", "runtime", "source-import"),
  rule("protocol", "coding-agent", "source-import"),
  rule("protocol", "storage", "source-import"),
  rule("protocol", "daemon", "source-import"),
  rule("protocol", "client", "source-import"),

  // @caelush/agent — general agent kernel. It knows no host execution.
  rule("agent", "coding-agent", "source-import"),
  rule("agent", "runtime", "source-import"),
  rule("agent", "storage", "source-import"),
  rule("agent", "client", "source-import"),
  rule("agent", "daemon", "source-import"),

  // @caelush/runtime — execution substrate. It knows no agent or product.
  rule("runtime", "agent", "source-import"),
  rule("runtime", "coding-agent", "source-import"),
  rule("runtime", "storage", "source-import"),
  rule("runtime", "client", "source-import"),
  rule("runtime", "daemon", "source-import"),

  // @caelush/coding-agent — coding composition. It may not own durability or UI.
  rule("coding-agent", "storage", "source-import"),
  rule("coding-agent", "client", "source-import"),
  rule("coding-agent", "daemon", "source-import"),

  // @caelush/storage — durable adapter layer, never an authority.
  rule("storage", "daemon", "source-import"),
  rule("storage", "client", "source-import"),
  rule("storage", "web", "source-import"),
  rule("storage", "cli", "source-import"),

  // @caelush/client — protocol-only consumer.
  rule("client", "agent", "source-import"),
  rule("client", "runtime", "source-import"),
  rule("client", "storage", "source-import"),
  rule("client", "coding-agent", "source-import"),

  // Hosts — Web and CLI consume the service, never the kernel.
  rule("web", "agent", "source-import"),
  rule("web", "runtime", "source-import"),
  rule("web", "storage", "source-import"),
  rule("web", "coding-agent", "source-import"),

  rule("cli", "agent", "source-import"),
  rule("cli", "runtime", "source-import"),
  rule("cli", "storage", "source-import"),
  rule("cli", "coding-agent", "source-import"),

  // Package dependency graph rules. A manifest dependency is a real architecture
  // edge even when no source file imports the package yet.
  rule("ai", "agent", "package-manifest"),
  rule("ai", "coding-agent", "package-manifest"),
  rule("ai", "runtime", "package-manifest"),
  rule("ai", "storage", "package-manifest"),
  rule("ai", "client", "package-manifest"),

  rule("protocol", "agent", "package-manifest"),
  rule("protocol", "runtime", "package-manifest"),
  rule("protocol", "coding-agent", "package-manifest"),
  rule("protocol", "storage", "package-manifest"),
  rule("protocol", "daemon", "package-manifest"),
  rule("protocol", "client", "package-manifest"),

  rule("agent", "coding-agent", "package-manifest"),
  rule("agent", "runtime", "package-manifest"),
  rule("agent", "storage", "package-manifest"),
  rule("agent", "client", "package-manifest"),
  rule("agent", "daemon", "package-manifest"),

  rule("runtime", "agent", "package-manifest"),
  rule("runtime", "coding-agent", "package-manifest"),
  rule("runtime", "storage", "package-manifest"),
  rule("runtime", "client", "package-manifest"),
  rule("runtime", "daemon", "package-manifest"),

  rule("coding-agent", "storage", "package-manifest"),
  rule("coding-agent", "client", "package-manifest"),
  rule("coding-agent", "daemon", "package-manifest"),

  rule("storage", "daemon", "package-manifest"),
  rule("storage", "client", "package-manifest"),
  rule("storage", "web", "package-manifest"),
  rule("storage", "cli", "package-manifest"),

  rule("client", "agent", "package-manifest"),
  rule("client", "runtime", "package-manifest"),
  rule("client", "storage", "package-manifest"),
  rule("client", "coding-agent", "package-manifest"),

  rule("web", "agent", "package-manifest"),
  rule("web", "runtime", "package-manifest"),
  rule("web", "storage", "package-manifest"),
  rule("web", "coding-agent", "package-manifest"),

  rule("cli", "agent", "package-manifest"),
  rule("cli", "runtime", "package-manifest"),
  rule("cli", "storage", "package-manifest"),
  rule("cli", "coding-agent", "package-manifest"),
];

/** Fast lookup from `${kind}\u0000${from}\u0000${to}` to the rule. */
export const RULE_INDEX = new Map(
  DEPENDENCY_RULES.map((entry) => [`${entry.kind}\u0000${entry.from}\u0000${entry.to}`, entry]),
);

/**
 * @param {ViolationKind} kind
 * @param {string} fromPackage
 * @param {string} toPackage
 * @returns {DependencyRule | undefined}
 */
export function findRule(kind, fromPackage, toPackage) {
  return RULE_INDEX.get(`${kind}\u0000${fromPackage}\u0000${toPackage}`);
}

/** Rule ids in deterministic order, used for stable report grouping. */
export const RULE_IDS = DEPENDENCY_RULES.map((entry) => entry.id).sort();
