/**
 * Caelush Architecture V2 legacy migration map.
 *
 * This module answers one question per legacy package: **where does its code
 * go?** It is a migration destination map, not a dependency allowlist. The two
 * must never be conflated:
 *
 *   - `v2-rules.mjs` says what a package may depend on today and in the final
 *     architecture.
 *   - this module says where a legacy package's responsibility must eventually
 *     live, and how that relocation happens.
 *
 * A destination of `runtime` means "these symbols relocate into the existing
 * `@caelush/runtime` package". `daemon` means the responsibility is host
 * composition, which stays in the Daemon. `DELETE` means no permanent package
 * keeps the responsibility; it is dissolved into its listed destinations or
 * removed outright.
 *
 * Operations
 * ----------
 *   MOVE     relocate the package mostly intact to one destination
 *   SPLIT    divide the package across several destinations by responsibility
 *   RENAME   the same responsibility continues under a new package identity
 *   EXTRACT  pull a specific concern out, leaving the rest behind
 *   ADAPT    the destination is not a copy: the code is rewritten to a new
 *            contract or port shape
 *   PORT     re-implement against a different substrate
 *   FACADE   the legacy package survives only as a re-export shim that points at
 *            the migrated target symbols. This is the ONLY sanctioned
 *            compatibility direction: legacy -> target.
 *   DELETE   remove without a replacement package
 *
 * @typedef {"MOVE" | "SPLIT" | "RENAME" | "EXTRACT" | "ADAPT" | "PORT" | "FACADE" | "DELETE"} MigrationOperation
 *
 * @typedef {{
 *   legacyPackage: string,
 *   destinations: string[],
 *   primaryOperation: MigrationOperation,
 *   operations: MigrationOperation[],
 *   rationale: string,
 *   splitGuide?: { concern: string, destination: string }[],
 * }} LegacyMigrationEntry
 */

/** The destination value that means "no permanent package keeps this". */
export const MIGRATION_DELETE = "DELETE";

/** The host destination that is a composition root rather than a package. */
export const MIGRATION_HOST_DESTINATIONS = ["daemon"];

/** Every migration operation Phase 1B recognises. */
export const MIGRATION_OPERATIONS = [
  "MOVE",
  "SPLIT",
  "RENAME",
  "EXTRACT",
  "ADAPT",
  "PORT",
  "FACADE",
  "DELETE",
];

/** @type {LegacyMigrationEntry[]} */
export const LEGACY_MIGRATION_MAP = [
  {
    legacyPackage: "llm",
    destinations: ["ai"],
    primaryOperation: "MOVE",
    operations: ["MOVE", "ADAPT", "FACADE"],
    rationale:
      "The model, provider, API adapter, message, stream and usage layer moves to the final AI package. Adapters adapt to the final AI contracts rather than carrying the legacy gateway shape across. The legacy package may survive only as a compatibility facade re-exporting the migrated symbols.",
  },
  {
    legacyPackage: "core",
    destinations: ["agent"],
    primaryOperation: "MOVE",
    operations: ["MOVE", "EXTRACT"],
    rationale:
      "The general agent kernel moves to the final agent package. Host execution, concrete tool invocation, persistence and coding concerns are extracted out rather than moved, because the final agent package may not know them.",
    splitGuide: [
      {
        concern: "Run lifecycle, AgentLoop, retry, budget, resource governance",
        destination: "agent",
      },
      { concern: "Persistence and commit orchestration", destination: "storage" },
      { concern: "Coding composition", destination: "coding-agent" },
    ],
  },
  {
    legacyPackage: "context",
    destinations: ["agent", "coding-agent"],
    primaryOperation: "SPLIT",
    operations: ["SPLIT"],
    rationale:
      "Generic context engine and context item assembly belong to the agent kernel. Workspace, project intelligence, relevant-file discovery and project instructions are coding-specific and belong to the coding agent.",
    splitGuide: [
      {
        concern: "Context engine, context items, budget arithmetic, model context assembly",
        destination: "agent",
      },
      {
        concern:
          "Workspace/project discovery, relevant files, project instructions, workspace context providers",
        destination: "coding-agent",
      },
    ],
  },
  {
    legacyPackage: "tools",
    destinations: ["agent", "coding-agent"],
    primaryOperation: "SPLIT",
    operations: ["SPLIT"],
    rationale:
      "Generic tool contract, registry, schema runtime, dispatcher lifecycle and batch coordination belong to the agent kernel. Concrete coding tools and their runtime-backed handlers belong to the coding agent. The execution primitives they call already live in runtime.",
    splitGuide: [
      {
        concern:
          "ToolDefinition, registry, schema runtime, dispatcher, observation, batch coordination",
        destination: "agent",
      },
      {
        concern:
          "read_file, list_directory, find_files, search_text, apply_patch, exec_command, write_stdin, git_status, git_diff handlers",
        destination: "coding-agent",
      },
      { concern: "Execution primitives behind those handlers", destination: "runtime" },
    ],
  },
  {
    legacyPackage: "security",
    destinations: ["agent", "coding-agent", "runtime"],
    primaryOperation: "SPLIT",
    operations: ["SPLIT"],
    rationale:
      "Generic security policy kernel, capability evaluation and the durable approval workflow belong to the agent kernel. Sensitive-path, command and coding-policy classification belong to the coding agent. Process environment hardening and path containment primitives already belong to runtime.",
    splitGuide: [
      {
        concern:
          "Generic policy kernel, capability matrix, approval workflow, result sanitization contracts",
        destination: "agent",
      },
      {
        concern: "Sensitive path classification, command policy, coding-specific security facts",
        destination: "coding-agent",
      },
      {
        concern: "Child environment allowlisting, path boundary enforcement",
        destination: "runtime",
      },
    ],
  },
  {
    legacyPackage: "verification",
    destinations: ["agent", "coding-agent"],
    primaryOperation: "SPLIT",
    operations: ["SPLIT"],
    rationale:
      "The generic completion gate and verification evidence contracts belong to the agent kernel. Project lint/typecheck/test/build resolution, changeset review and task acceptance are coding-specific and belong to the coding agent.",
    splitGuide: [
      {
        concern: "Generic completion gate, evidence and seal contracts, evaluator",
        destination: "agent",
      },
      {
        concern: "Project command resolution, changeset sanity and review, task acceptance",
        destination: "coding-agent",
      },
    ],
  },
  {
    legacyPackage: "memory",
    destinations: ["agent"],
    primaryOperation: "MOVE",
    operations: ["MOVE", "ADAPT"],
    rationale:
      "Memory contracts belong to the agent kernel, which owns conversation and session domain. The durable side of memory stays behind storage ports, so the moved implementation adapts to ports rather than owning persistence.",
  },
  {
    legacyPackage: "events",
    destinations: ["agent", "storage", "daemon"],
    primaryOperation: "SPLIT",
    operations: ["SPLIT"],
    rationale:
      "Agent event contracts and the event bus belong to the agent kernel. The durable event store adapter and its sequence persistence belong to storage. Live SSE fan-out remains host composition in the daemon.",
    splitGuide: [
      {
        concern: "Agent event contracts, event bus, replay cursor semantics",
        destination: "agent",
      },
      { concern: "Durable event store adapter, sequence persistence", destination: "storage" },
      { concern: "Live streaming fan-out and HTTP/SSE transport", destination: "daemon" },
    ],
  },
  {
    legacyPackage: "shared",
    destinations: ["runtime", "coding-agent"],
    primaryOperation: "SPLIT",
    operations: ["SPLIT", "DELETE"],
    rationale:
      "The shared utility surface is dissolved: low-level execution and path utilities go to runtime, coding-oriented helpers go to the coding agent, and whatever is genuinely generic is inlined at its single caller. No package named shared survives in the final graph.",
    splitGuide: [
      { concern: "Low-level path, text and process utilities", destination: "runtime" },
      { concern: "Coding-oriented helpers", destination: "coding-agent" },
    ],
  },
  {
    legacyPackage: "observability",
    destinations: [],
    primaryOperation: "DELETE",
    operations: ["DELETE"],
    rationale:
      "No permanent Architecture V2 package owns observability. Logging and tracing are host concerns: the daemon composes them, and any shared shape is expressed through protocol contracts rather than a feature package.",
  },
];

/** Fast lookup from legacy package identity to its migration entry. */
export const MIGRATION_MAP_INDEX = new Map(
  LEGACY_MIGRATION_MAP.map((entry) => [entry.legacyPackage, entry]),
);

/**
 * @param {string} legacyPackage
 * @returns {LegacyMigrationEntry | undefined}
 */
export function migrationEntryFor(legacyPackage) {
  return MIGRATION_MAP_INDEX.get(legacyPackage);
}

/**
 * All destinations named anywhere in the migration map, sorted and de-duplicated.
 *
 * @returns {string[]}
 */
export function allMigrationDestinations() {
  return [
    ...new Set(
      LEGACY_MIGRATION_MAP.flatMap((entry) =>
        entry.destinations.length === 0 ? [MIGRATION_DELETE] : entry.destinations,
      ),
    ),
  ].sort();
}

/**
 * Legacy packages that are fully removed rather than relocated.
 *
 * @returns {string[]}
 */
export function deletedLegacyPackages() {
  return LEGACY_MIGRATION_MAP.filter((entry) => entry.operations.includes("DELETE"))
    .map((entry) => entry.legacyPackage)
    .sort();
}
