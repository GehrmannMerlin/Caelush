# Caelush Architecture V2 — Public API and Migration Policy

This document freezes the **public boundary** and the **one-way migration
direction** of Caelush Architecture V2, and points at the machine rules that
enforce both.

Two invariants:

```text
1. A package is consumed only through its declared public export surface.
2. Compatibility flows legacy -> target. Never target -> legacy.
```

The machine-readable sources of truth are:

```text
scripts/architecture/v2-rules.mjs          rule set version 2, allowlist-derived
scripts/architecture/v2-migration-map.mjs  where each legacy package's code goes
scripts/architecture/check-boundaries.mjs  the executable check
scripts/architecture/legacy-import-baseline.json  frozen pre-existing debt
```

Run `pnpm check:architecture` to enforce them. A violation fails CI.

---

## 1. Public package import

A package's public surface is exactly what its `package.json` `exports` map
declares. A consumer may import:

```ts
import { thing } from "@caelush/agent"; // the "." entry
import { message } from "@caelush/llm/messages"; // a declared subpath entry
```

A consumer may **never** import:

```ts
import { internal } from "@caelush/agent/src/internal/foo"; // private source
import { secret } from "@caelush/agent/not-exported"; // undeclared subpath
```

The rule is `exports`-driven, not `subpath`-driven. Phase 1B does not ban "all
package subpaths"; it bans subpaths that the owning package has not published.
`@caelush/llm/messages` stays legal for exactly as long as `@caelush/llm` declares
`"./messages"` in its exports map.

### 1.1 Why `exports` and not the filesystem

`exports` is the only contract a package states about itself. A file existing in
`src/` is an implementation detail; a key existing in `exports` is a published
promise. Reading the export map keeps the guard honest for packages that have not
been migrated yet and for packages that will publish new subpaths later.

### 1.2 Root entry only

The three Architecture V2 skeletons (`@caelush/ai`, `@caelush/agent`,
`@caelush/coding-agent`) declare only `"."` in Phase 1B. Future subpaths are added
when real migrated code needs them, never speculatively.

## 2. Package export map

The seven target packages and their final allowed dependency direction:

| Package                 | Allowed target dependencies                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `@caelush/ai`           | none                                                                     |
| `@caelush/protocol`     | none                                                                     |
| `@caelush/agent`        | `@caelush/ai`, `@caelush/protocol`                                       |
| `@caelush/runtime`      | `@caelush/protocol`                                                      |
| `@caelush/coding-agent` | `@caelush/ai`, `@caelush/agent`, `@caelush/runtime`, `@caelush/protocol` |
| `@caelush/storage`      | `@caelush/agent`, `@caelush/protocol`                                    |
| `@caelush/client`       | `@caelush/protocol`                                                      |

This is an **allowlist**, not an obligation. `Dependency follows real code`: a
package declares a dependency when a source file uses it, never to display the
future graph.

The forbidden target graph is **derived** from this allowlist. Adding a target
package to `V2_TARGET_PACKAGES` automatically forbids every direction that is not
explicitly allowed, so `client -> ai`, `runtime -> ai`, and `storage ->
coding-agent` cannot be forgotten the way a hand-written forbidden list can.

`@caelush/protocol` is treated as a universal contract: every target may depend
on it, and `V2_UNIVERSAL_TARGETS` states that once instead of repeating it in
seven allowlists.

## 3. Private source import

An import that reaches into another workspace project's source tree is forbidden:

```ts
@caelush/ai/src/...
@caelush/agent/src/...
@caelush/coding-agent/src/...
@caelush/runtime/src/...
@caelush/storage/src/...
@caelush/protocol/src/...
@caelush/client/src/...
```

Rule id: `PACKAGE_MUST_NOT_BE_IMPORTED_THROUGH_SRC`.

This holds for every workspace project, not only the seven targets, because the
rule protects the export surface rather than a specific package pair.

## 4. Cross-workspace relative import

A relative import may not cross a workspace project boundary:

```ts
// packages/agent/src/foo.ts
import { x } from "../../protocol/src/index.js"; // FORBIDDEN

// packages/agent/src/foo.ts
import { x } from "./internal/foo.js"; // allowed, same package
```

Rule id: `PACKAGE_MUST_NOT_IMPORT_ANOTHER_PROJECT_BY_RELATIVE_PATH`.

A relative import inside one project is ordinary internal structure and stays
legal. Relative imports are resolved against the importing file, and the result
is checked against the real project directories, so `../../../protocol/src/x.js`
is caught from any depth. Extensionless NodeNext source (`./foo.js` referring to
`foo.ts`) is resolved before the check, so the rule does not depend on file
extensions being written literally.

## 5. Legacy compatibility direction

**Allowed:** `legacy -> target`.

```ts
// legacy @caelush/llm, after real AI symbols have moved
export { complete } from "@caelush/ai";
```

```ts
// legacy @caelush/core, after the real kernel has moved
export { AgentLoop } from "@caelush/agent";
```

This is the sanctioned compatibility shim: the legacy package survives as a
re-export facade pointing at the migrated target symbols.

### 5.1 When a shim may be created

Only when the real symbol already lives in the target package. The shim must
re-export a symbol that genuinely moved, so the legacy import path keeps working
while the implementation has one home.

### 5.2 Never create it in Phase 1B

Phase 1B creates no shim. There is no migrated symbol yet, so a shim would be a
lie: it would re-export a legacy implementation through a new name and make the
migration look finished while nothing moved.

## 6. Target to legacy prohibition

**Forbidden, permanently:** `target -> legacy`.

```ts
// packages/ai/src/foo.ts
import { LLMMessage } from "@caelush/llm"; // FORBIDDEN
```

```ts
// packages/agent/src/foo.ts
import { RunController } from "@caelush/core"; // FORBIDDEN
```

```ts
// packages/coding-agent/src/foo.ts
import { ToolDispatcher } from "@caelush/tools"; // FORBIDDEN
```

```json
{
  "name": "@caelush/agent",
  "dependencies": { "@caelush/core": "workspace:*" }
}
```

Both layers are enforced: source imports and `package.json` workspace
dependencies across `dependencies`, `devDependencies`, `peerDependencies`, and
`optionalDependencies`.

Rule ids follow `<FROM>_MUST_NOT_DEPEND_ON_<TO>` and
`<FROM>_MUST_NOT_DECLARE_DEPENDENCY_ON_<TO>`.

### 6.1 The legacy packages

```text
llm  core  context  tools  security  verification  memory  events  shared  observability
```

### 6.2 No temporary exception

There is no "for now" version of this direction. A target package that depends on
a legacy package is not a nearly-finished migration; it is an unfinished one that
has acquired a permanent second home for the same responsibility. The ratchet
freezes the debt that already exists and refuses every new occurrence.

### 6.3 Target to host prohibition

A package may never depend on an app:

```ts
// packages/agent/src/foo.ts
import { boot } from "@caelush/daemon/entry"; // FORBIDDEN
```

The direction is `apps -> packages`, never the reverse. Phase 1A forbade
`protocol -> daemon`, `agent -> daemon`, `runtime -> daemon`, and
`coding-agent -> daemon`; Phase 1B generalises it to every target and every host
(`daemon`, `cli`, `web`, `launcher`) so the rule survives a package being added.

## 7. Public subpath rule

```text
A subpath is public when the owning package.json exports map has an exact key
for it, or a wildcard key such as "./features/*" that matches it.
```

| Import                      | Owning exports        | Verdict                                                       |
| --------------------------- | --------------------- | ------------------------------------------------------------- |
| `@caelush/llm`              | `"."`                 | allowed                                                       |
| `@caelush/llm/messages`     | `"."`, `"./messages"` | allowed                                                       |
| `@caelush/llm/not-exported` | `"."`, `"./messages"` | **forbidden** — `PACKAGE_SUBPATH_MUST_BE_DECLARED_IN_EXPORTS` |
| `@caelush/agent/src/x`      | `"."`                 | **forbidden** — `PACKAGE_MUST_NOT_BE_IMPORTED_THROUGH_SRC`    |

A `"."` entry never makes a subpath public. A package with no `exports` field at
all publishes only its root.

## 8. Violation classes

The checker reports why an edge is illegal, not only that it is:

| Class                             | Meaning                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `target-graph`                    | A target depends on a target the allowlist does not permit             |
| `target-to-legacy`                | A target depends on a package Architecture V2 is deleting              |
| `target-to-host`                  | A package depends on an app                                            |
| `host-boundary`                   | A host depends on a target the host boundary forbids                   |
| `package-manifest`                | The violation is in `package.json`, whatever the underlying edge class |
| `private-import`                  | A subpath bypasses the public export surface                           |
| `cross-workspace-relative-import` | A relative import crosses a project boundary                           |

## 9. Ratchet and rule-set expansion

The baseline in `scripts/architecture/legacy-import-baseline.json` is a ratchet:

| Situation                                 | Outcome                         |
| ----------------------------------------- | ------------------------------- |
| A violation listed in the baseline        | allowed, frozen                 |
| A violation **not** listed                | `FAIL` — `NEW_VIOLATION`        |
| A listed entry with no matching violation | `FAIL` — `STALE_BASELINE_ENTRY` |
| A duplicated entry                        | `FAIL`                          |

The baseline may only shrink. It may grow **only** through the audited rule-set
expansion protocol:

```bash
node scripts/architecture/check-boundaries.mjs --write-baseline \
  --accept-rule-expansion --baseline-source-commit <sha>
```

which requires:

```text
HEAD is exactly <sha>
every scanned path is committed (a dirty tree cannot prove an edge pre-existed)
an explicit opt-in flag
```

so the admitted set is provably that commit's own debt. CI refuses any growing
write regardless of flags, and `pnpm check:architecture` never writes at all.

Phase 1B used this protocol exactly once, to move the rule set from version 1 to
version 2 and admit the 33 target-to-legacy violations that already existed at
the Phase 1A commit. See `PHASE_1B_DEPENDENCY_AND_MIGRATION_REPORT.md`.

## 10. Migration destination map

`scripts/architecture/v2-migration-map.mjs` states where each legacy package's
responsibility goes. It is a **destination map**, not a dependency allowlist.

| Legacy package  | Destination                        | Operation             |
| --------------- | ---------------------------------- | --------------------- |
| `llm`           | `ai`                               | MOVE + ADAPT + FACADE |
| `core`          | `agent`                            | MOVE + EXTRACT        |
| `context`       | `agent`, `coding-agent`            | SPLIT                 |
| `tools`         | `agent`, `coding-agent`            | SPLIT                 |
| `security`      | `agent`, `coding-agent`, `runtime` | SPLIT                 |
| `verification`  | `agent`, `coding-agent`            | SPLIT                 |
| `memory`        | `agent`                            | MOVE + ADAPT          |
| `events`        | `agent`, `storage`, `daemon`       | SPLIT                 |
| `shared`        | `runtime`, `coding-agent`          | SPLIT + DELETE        |
| `observability` | none                               | DELETE                |

The two maps answer different questions and must not be conflated:

- the allowlist says what a package **may depend on**;
- the migration map says where code **goes**.

`tools -> runtime` exists today as a dependency. That does not make `runtime` a
package `tools` may depend on after migration, and it does not keep
`@caelush/tools` alive: the destination map splits the package across `agent`
(tool contracts), `coding-agent` (coding tools), and `runtime` (execution
primitives).

## 11. Non-negotiables

```text
- A target package never imports a legacy package.
- A package never imports an app.
- A package is consumed only through its declared exports.
- A relative import never crosses a project boundary.
- Compatibility is legacy -> target, and only for symbols that already moved.
- The baseline never grows except through the audited expansion protocol.
- No facade, shim, or re-export is created before the symbol actually moves.
```
