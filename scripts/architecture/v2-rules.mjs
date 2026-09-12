/**
 * Caelush Architecture V2 dependency rules.
 *
 * This module is the machine-readable form of the frozen Architecture V2
 * dependency matrix. It contains no scanner logic and no baseline logic so the
 * rule matrix can be reviewed as pure data and derivation.
 *
 * Rule model
 * ----------
 * The rules are **derived**, never hand-listed:
 *
 *   V2_ALLOWED_DEPENDENCIES   one allowlist per target package
 *              +
 *   V2_UNIVERSAL_TARGETS      packages every target may depend on
 *              +
 *   V2_LEGACY_PACKAGES        packages with no permanent Architecture V2 home
 *              ↓
 *   deriveTargetGraphRules()  allowed -> forbidden target edges
 *   deriveTargetToLegacyRules()   target -> legacy prohibition
 *              ↓
 *   DEPENDENCY_RULES          the frozen rule list the checker evaluates
 *
 * Adding a future target package to the allowlist automatically forbids every
 * direction that is not explicitly allowed, so `client -> ai`, `runtime -> ai`
 * and `storage -> coding-agent` can never be forgotten again.
 *
 * Identity model
 * --------------
 * Every workspace project has a stable "package identity" derived from its
 * package.json `name` (the `caelush` scope is stripped). Legacy packages keep
 * their legacy identity (`core`, `llm`, `shared`, ...) because Phase 1A does not
 * re-identify them. Architecture V2 target packages use their final identity
 * (`ai`, `agent`, `coding-agent`, ...).
 *
 * @typedef {"source-import" | "package-manifest"} ViolationLayer
 * @typedef {"target-graph" | "target-to-legacy" | "host-boundary" | "target-to-host" | "package-manifest" | "private-import" | "cross-workspace-relative-import" | "legacy-to-legacy" | "legacy-to-target" | "unknown"} ViolationKind
 *
 * @typedef {{
 *   id: string,
 *   layer: ViolationLayer,
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

/** Rule set version. Phase 1A shipped version 1; Phase 1B expands it to 2. */
export const RULE_SET_VERSION = 2;

/** The rule set version whose baseline a Phase 1A checkout produced. */
export const PHASE_1A_RULE_SET_VERSION = 1;

/** Commit that Phase 1A shipped as its final result. */
export const PHASE_1A_FINAL_COMMIT = "2e0befea64e303374c59dfd873188b95b0f484d4";

/**
 * Allowed direction of the Architecture V2 target graph.
 *
 * This is an **allowlist**. It states what a target package may depend on in the
 * final architecture; it never obliges a package to declare a dependency it does
 * not use. `Dependency follows real code` remains the rule.
 *
 * `protocol` is absent as a value because it is a universal contract every
 * target may depend on; see `V2_UNIVERSAL_TARGETS`.
 */
export const V2_ALLOWED_DEPENDENCIES = /** @type {Record<string, readonly string[]>} */ ({
  ai: [],
  protocol: [],
  agent: ["ai"],
  runtime: [],
  "coding-agent": ["ai", "agent", "runtime"],
  storage: ["agent"],
  client: [],
});

/**
 * Targets that every Architecture V2 target package may depend on.
 *
 * `protocol` is the cross-process contract layer. It is the bottom of the graph,
 * so depending on it never violates a direction. Listing it in every allowlist
 * would duplicate one fact seven times and invite drift, so it lives here.
 */
export const V2_UNIVERSAL_TARGETS = ["protocol"];

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

/**
 * Packages that exist today and that Architecture V2 does not keep.
 *
 * A target package may never depend on one of these. Compatibility flows
 * legacy -> target, never target -> legacy. See `v2-migration-map.mjs` for where
 * each one's responsibility goes.
 */
export const V2_LEGACY_PACKAGES = [
  "llm",
  "core",
  "context",
  "tools",
  "security",
  "verification",
  "memory",
  "events",
  "shared",
  "observability",
];

/** Architecture V2 packages that Phase 1A does not create. */
export const V2_PHASE_1A_DEFERRED_PACKAGES = ["protocol", "runtime", "storage", "client"];

/** Architecture V2 packages that Phase 1A creates as empty skeletons. */
export const V2_PHASE_1A_CREATED_PACKAGES = ["ai", "agent", "coding-agent"];

/** Every package identity a source file or manifest may belong to. */
export const V2_KNOWN_PACKAGE_IDENTITIES = [
  ...V2_TARGET_PACKAGES,
  ...V2_HOST_APPS,
  ...V2_LEGACY_PACKAGES,
];

const TARGET_SET = new Set(V2_TARGET_PACKAGES);
const HOST_SET = new Set(V2_HOST_APPS);
const LEGACY_SET = new Set(V2_LEGACY_PACKAGES);
const UNIVERSAL_SET = new Set(V2_UNIVERSAL_TARGETS);

/**
 * @param {string} identity
 * @returns {"target" | "host" | "legacy" | "unknown"}
 */
export function packageRole(identity) {
  if (TARGET_SET.has(identity)) return "target";
  if (HOST_SET.has(identity)) return "host";
  if (LEGACY_SET.has(identity)) return "legacy";
  return "unknown";
}

/**
 * @param {string} identity
 * @returns {boolean}
 */
export function isTargetPackage(identity) {
  return TARGET_SET.has(identity);
}

/**
 * @param {string} identity
 * @returns {boolean}
 */
export function isLegacyPackage(identity) {
  return LEGACY_SET.has(identity);
}

/**
 * @param {string} identity
 * @returns {boolean}
 */
export function isHostApp(identity) {
  return HOST_SET.has(identity);
}

/**
 * May `from` depend on `to` in the final Architecture V2 graph?
 *
 * Only target -> target directions are expressed by the allowlist. Hosts compose
 * everything, and legacy packages are mid-migration, so this function answers
 * strictly about the target graph.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isAllowedTargetEdge(from, to) {
  if (!TARGET_SET.has(from) || !TARGET_SET.has(to) || from === to) {
    return false;
  }
  if (UNIVERSAL_SET.has(to)) {
    return true;
  }
  return (V2_ALLOWED_DEPENDENCIES[from] ?? []).includes(to);
}

/**
 * Every forbidden target -> target edge, derived from the allowlist. Includes
 * targets that do not exist yet, so a future package cannot be added without its
 * boundary being enforced.
 *
 * @returns {{ from: string, to: string }[]}
 */
export function deriveForbiddenTargetEdges() {
  const edges = [];
  for (const from of V2_TARGET_PACKAGES) {
    for (const to of V2_TARGET_PACKAGES) {
      if (from === to) continue;
      if (isAllowedTargetEdge(from, to)) continue;
      edges.push({ from, to });
    }
  }
  return edges;
}

/**
 * Every forbidden target -> legacy edge. This is the compatibility direction
 * lock: a target package may never reach back into a package that Architecture
 * V2 is deleting.
 *
 * @returns {{ from: string, to: string }[]}
 */
export function deriveForbiddenTargetToLegacyEdges() {
  const edges = [];
  for (const from of V2_TARGET_PACKAGES) {
    for (const to of V2_LEGACY_PACKAGES) {
      edges.push({ from, to });
    }
  }
  return edges;
}

/**
 * Host applications that a target package may never depend on.
 *
 * The dependency direction is `apps -> packages`, never the reverse. Phase 1A
 * forbade `protocol -> daemon`, `agent -> daemon`, `runtime -> daemon`, and
 * `coding-agent -> daemon`; Phase 1B generalises that to every target and every
 * host so the rule cannot be lost when a package is added. `launcher` is included
 * because it is an app like any other.
 */
export const V2_FORBIDDEN_TARGET_TO_HOST = ["daemon", "cli", "web", "launcher"];

/**
 * Every forbidden target -> host edge.
 *
 * @returns {{ from: string, to: string }[]}
 */
export function deriveForbiddenTargetToHostEdges() {
  const edges = [];
  for (const from of V2_TARGET_PACKAGES) {
    for (const to of V2_FORBIDDEN_TARGET_TO_HOST) {
      if (!HOST_SET.has(to)) {
        throw new Error(
          `V2_FORBIDDEN_TARGET_TO_HOST lists "${to}", which is not a declared host app`,
        );
      }
      edges.push({ from, to });
    }
  }
  return edges;
}

/**
 * Every forbidden host -> target edge. Hosts are allowed to compose every
 * package, so the host boundary is expressed as an explicit host -> target
 * restriction list rather than an allowlist.
 */
export const V2_FORBIDDEN_HOST_TO_TARGET = /** @type {Record<string, readonly string[]>} */ ({
  web: ["agent", "runtime", "storage", "coding-agent"],
  cli: ["agent", "runtime", "storage", "coding-agent"],
  daemon: [],
  launcher: [],
});

/**
 * Every forbidden host -> target edge, derived from the host restriction list.
 *
 * @returns {{ from: string, to: string }[]}
 */
export function deriveForbiddenHostEdges() {
  const edges = [];
  for (const from of V2_HOST_APPS) {
    for (const to of V2_FORBIDDEN_HOST_TO_TARGET[from] ?? []) {
      if (!TARGET_SET.has(to)) {
        throw new Error(
          `V2_FORBIDDEN_HOST_TO_TARGET lists "${to}" for host "${from}", which is not a target package`,
        );
      }
      edges.push({ from, to });
    }
  }
  return edges;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {ViolationLayer} layer
 * @returns {DependencyRule}
 */
function buildRule(from, to, layer) {
  const kind = classifyRuleKind(from, to, layer);
  const suffix =
    layer === "source-import" ? "MUST_NOT_DEPEND_ON" : "MUST_NOT_DECLARE_DEPENDENCY_ON";
  const id = `${from.toUpperCase().replaceAll("-", "_")}_${suffix}_${to
    .toUpperCase()
    .replaceAll("-", "_")}`;

  return {
    id,
    layer,
    kind,
    from,
    to,
    description:
      layer === "source-import"
        ? `@caelush/${from} must not import @caelush/${to} from source (${kind})`
        : `@caelush/${from} must not declare a workspace dependency on @caelush/${to} (${kind})`,
  };
}

/**
 * Classify why an edge is forbidden. A manifest edge reports as a
 * `package-manifest` violation because the fix is in the package manifest, while
 * the underlying edge class is preserved in `edgeClass`.
 *
 * @param {string} from
 * @param {string} to
 * @param {ViolationLayer} layer
 * @returns {ViolationKind}
 */
export function classifyRuleKind(from, to, layer) {
  if (layer === "package-manifest") {
    return "package-manifest";
  }
  const fromRole = packageRole(from);
  const toRole = packageRole(to);

  if (fromRole === "target" && toRole === "legacy") {
    return "target-to-legacy";
  }
  if (fromRole === "target" && toRole === "host") {
    return "target-to-host";
  }
  if (fromRole === "target" && toRole === "target") {
    return "target-graph";
  }
  if (fromRole === "host") {
    return "host-boundary";
  }
  if (fromRole === "legacy" && toRole === "legacy") {
    return "legacy-to-legacy";
  }
  if (fromRole === "legacy" && toRole === "target") {
    return "legacy-to-target";
  }
  return "unknown";
}

/**
 * The frozen rule list, derived from the allowlist plus the compatibility
 * direction lock. Every forbidden edge appears once per layer.
 *
 * @type {DependencyRule[]}
 */
export const DEPENDENCY_RULES = (() => {
  /** @type {DependencyRule[]} */
  const rules = [];
  const seen = new Set();

  /** @param {{ from: string, to: string }[]} edges */
  const addEdges = (edges) => {
    for (const { from, to } of edges) {
      for (const layer of /** @type {ViolationLayer[]} */ (["source-import", "package-manifest"])) {
        const rule = buildRule(from, to, layer);
        if (seen.has(rule.id)) {
          throw new Error(`Duplicate Architecture V2 rule id: ${rule.id}`);
        }
        seen.add(rule.id);
        rules.push(rule);
      }
    }
  };

  addEdges(deriveForbiddenTargetEdges());
  addEdges(deriveForbiddenTargetToLegacyEdges());
  addEdges(deriveForbiddenTargetToHostEdges());
  addEdges(deriveForbiddenHostEdges());

  return rules;
})();

/** Fast lookup from `${layer}\u0000${from}\u0000${to}` to the rule. */
export const RULE_INDEX = new Map(
  DEPENDENCY_RULES.map((entry) => [`${entry.layer}\u0000${entry.from}\u0000${entry.to}`, entry]),
);

/**
 * @param {ViolationLayer} layer
 * @param {string} fromPackage
 * @param {string} toPackage
 * @returns {DependencyRule | undefined}
 */
export function findRule(layer, fromPackage, toPackage) {
  return RULE_INDEX.get(`${layer}\u0000${fromPackage}\u0000${toPackage}`);
}

/** Rule ids in deterministic order, used for stable report grouping. */
export const RULE_IDS = DEPENDENCY_RULES.map((entry) => entry.id).sort();

/** Rule counts by kind, used for report headers and the CLI banner. */
export function ruleCountsByKind() {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const rule of DEPENDENCY_RULES) {
    counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Public boundary rule identifiers. They are evaluated by shape rather than by
 * package pair, so they are not part of `DEPENDENCY_RULES`.
 */
export const PUBLIC_BOUNDARY_RULES =
  /** @type {Record<string, { kind: ViolationKind, id: string, description: string }>} */ ({
    privateSourceImport: {
      id: "PACKAGE_MUST_NOT_BE_IMPORTED_THROUGH_SRC",
      kind: "private-import",
      description:
        "A package subpath that enters another package's src directory bypasses the public export surface",
    },
    undeclaredExport: {
      id: "PACKAGE_SUBPATH_MUST_BE_DECLARED_IN_EXPORTS",
      kind: "private-import",
      description:
        "A package subpath must be declared in that package's package.json exports map to be publicly consumable",
    },
    crossWorkspaceRelativeImport: {
      id: "PACKAGE_MUST_NOT_IMPORT_ANOTHER_PROJECT_BY_RELATIVE_PATH",
      kind: "cross-workspace-relative-import",
      description:
        "A relative import may not cross a workspace project boundary into another project's private source",
    },
  });
