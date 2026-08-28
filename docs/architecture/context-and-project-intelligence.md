# Context and Project Intelligence

Phase 5A gives Caelush a bounded, read-only way to understand the workspace and project it is operating in. It discovers facts and their evidence; it does not choose facts for an LLM prompt. Phase 5B separately owns task-dependent relevant source-file discovery and budgeting. Phase 5C now owns final in-memory model-context assembly; see [ContextBuilder](context-builder.md) and [Relevant Context Discovery](relevant-context-discovery.md).

## Pipeline

```text
WorkspaceRef
    │
    ▼
WorkspaceScopeResolver
    │
    ▼
ProjectRootDetector
    │
    ├───────────┐
    ▼           ▼
Environment   ProjectProfile
    │           │
    └─────┬─────┘
          ▼
Instruction Discovery
          │
          ▼
ProjectIntelligenceSnapshot
```

## Three path concepts

- **Workspace root** is the caller-provided `WorkspaceRef.path`. It must be absolute, exist, and be a directory. The scope stores both its logical normalized path and its realpath.
- **Project root** is evidence-driven and may be equal to or below the workspace root. It is the boundary for project root detection and project instructions. It is selected by the nearest evidence tier: `.git`, workspace marker, project manifest, then cwd fallback.
- **cwd** is the inspection location. A missing cwd defaults to the workspace root; a relative cwd is resolved against the logical workspace root. Both logical and real cwd must remain within the workspace realpath, so `..`, absolute escapes, and symlink escapes fail closed.

The context boundary is only a read boundary. It is not the Phase 9 PermissionManager or a complete Runtime sandbox.

## Project root algorithm

The detector searches upward from cwd and never inspects the workspace parent:

```text
.git
  ↓
workspace marker
  ↓
project manifest
  ↓
cwd fallback
```

`.git` may be a directory or a Git worktree file. Workspace markers include `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `rush.json`, and a `package.json` with an explicit `workspaces` field. Project manifests include Node, Python, Rust, Go, and Java known files. Results carry a reason and evidence path rather than only a string path.

## Project profile

`ProjectProfile` contains only bounded known-file evidence from project root through cwd. It identifies NODE, PYTHON, RUST, GO, and JAVA, records a TypeScript signal from `tsconfig.json`, preserves manifest paths, and distinguishes the root package from the nearest active package. Node package metadata is limited to name, package manager field, Node engine range, scripts, and workspaces; dependencies are deliberately excluded. Script names are sorted for deterministic output.

Package-manager rules are explicit: a root `packageManager` field wins; otherwise known root lockfiles provide a signal. Conflicting lockfile managers produce `UNKNOWN` plus a diagnostic rather than a guess. Rust/Go/Java tools are retained as separate evidence, including simultaneous Maven and Gradle evidence.

Malformed project manifests produce a `MALFORMED_MANIFEST` warning and do not abort the rest of discovery. This is different from unreadable project instructions, which fail closed because silently dropping project rules could cause an agent to violate them.

## Project instruction discovery

The instruction search range is project root down to cwd. Within each directory the precedence is:

```text
AGENTS.override.md
        >
AGENTS.md
        >
CLAUDE.md fallback
```

At most one candidate is selected per directory. An existing empty override still wins over the lower-precedence files in that directory; whitespace-only content is not emitted as an entry. Entries are ordered root to cwd so more-specific instructions appear later and carry path, relative path, kind, depth, byte count, and truncation provenance.

The default total budget is **32768 bytes**, not a token budget. If a file exceeds the remaining budget, only a valid UTF-8 prefix is included, `truncated` is set, and later files are not read. Invalid UTF-8, unreadable files, and instruction symlinks whose realpath leaves the workspace are typed fatal errors. Text such as `@docs/style.md` is preserved literally; Phase 5A does not follow references, fetch remote URLs, or read global user instruction files.

## Filesystem and public API

`ContextFileSystem` has only metadata, bounded text read, directory listing, and realpath operations. `LocalContextFileSystem` is the Node adapter; no write, process, shell, network, or package-manager execution is available through this port. `ProjectInspector` receives this port and detector dependencies by injection. `createLocalProjectInspector()` provides the local composition without starting a daemon or creating a global singleton.

`ProjectIntelligenceSnapshot` is a runtime value containing workspace scope, root detection, environment, profile, instructions, and diagnostics. It is not a Storage snapshot and contains no LLM messages, prompt, provider metadata, database row, or entire source-file body.

## Phase boundary

Phase 5A stops at project intelligence. Phase 5B defines candidate file discovery, ignore policy, path scoring, metadata ranking, provenance sections, token estimation, and relevant-file budget allocation. Phase 5C assembles `BuiltModelContext` from those values, structured history, the current user message, and caller-supplied limits. No phase in this pipeline invokes the LLM or executes local tools.
