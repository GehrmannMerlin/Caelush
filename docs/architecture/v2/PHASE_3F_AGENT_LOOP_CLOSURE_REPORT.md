# Caelush Architecture V2 — Phase 3F Closure Report

```text
PHASE 3F — Agent Loop Production Composition & Migration Closure
branch   deepseek/architecture-v2-phase-3f-agent-loop-closure
base     bbc2ebd007527aace7535b80831f914c67fde140
```

Phase 3F is the final Phase 3 round. It converged the three execution paths that Phase 3C/3D/3E had
connected, retired the Run Layer's own completion composition, proved the general agent chain
standalone, repaired the browser fixture, and closed the phase. It did not open a new subsystem.

---

## 1. Base and branch

|                       | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| Base branch           | `deepseek/architecture-v2-phase-3e-completion-gate-migration` |
| Base SHA              | `bbc2ebd007527aace7535b80831f914c67fde140`                    |
| Working branch        | `deepseek/architecture-v2-phase-3f-agent-loop-closure`        |
| Base ancestor of HEAD | yes (`git merge-base --is-ancestor` exit 0)                   |
| Starting working tree | clean                                                         |

---

## 2. Scan findings

Every fact below was read from source, not from a report.

| Finding                                                                                                                                                   | Evidence                                                                                 | Disposition                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `RunControllerDependencies` carried 18 `verification*` fields and `run-controller.ts` read all of them                                                    | `run-controller.ts` `completionDependencies()` (77 lines of field-by-field assembly)     | extracted                                            |
| The Run Layer built the `TaskAcceptanceReviewer` itself                                                                                                   | `run-controller.ts`: `new TaskAcceptanceReviewer({...})` inside `completionDependencies` | extracted                                            |
| The Run Layer built the candidate-boundary planner and, before Phase 3E's own guard, the gate                                                             | `run-controller.ts` `openCompletionBoundary`                                             | extracted                                            |
| The Run Layer compiled the verification repair context and resolved the verification execution store                                                      | `run-controller.ts` `verificationRepairContext()` / `verificationRecoveryStore()`        | extracted                                            |
| `agent-loop.ts` (the legacy Reason facade) imported the legacy model-turn _executor implementation_ to reach one pure mapping                             | `import { toModelTurnExecutionError } from "./legacy-model-turn-executor.js"`            | mapping extracted to its own module                  |
| `docs/architecture/v2/` contained no Phase 3 document; the Phase 3A–3E reports existed only as commit messages                                            | `git ls-files docs/architecture/v2`                                                      | recorded; this report and three companions written   |
| The Phase 3 design attachments are not in the repository                                                                                                  | `git ls-files` matches no `Caelush_Agent_Loop_V2_*` file                                 | recorded; the frozen contract is taken from source   |
| `scripts/web-session-browser-smoke.mjs` passed `providerOverrides`, an option `DaemonOptions` does not declare                                            | `apps/daemon/src/daemon.ts:12-24`                                                        | replaced with the supported `providers` seam         |
| `rg` was absent from the host, so two storage tests failed as `RIPGREP_UNAVAILABLE`                                                                       | `Get-Command rg` failed; `RIPGREP_EXECUTABLE = "rg"`                                     | ripgrep 15.2.0 installed; both tests pass            |
| The recovery matrix had uncovered restart-fidelity rows: `WAITING_RESOURCE`, `WAITING_RETRY`, the observation-policy fallback, deadline-during-completion | independent coverage audit                                                               | five new file-backed tests                           |
| `apps/web/test/browser-safe-build.test.ts` runs a real `vite build` into `apps/web/dist`, which vite empties first                                        | the test file, unmodified since the baseline                                             | recorded as a pre-existing test-isolation race (§12) |

---

## 3. Before / after

```text
BEFORE
  RunController ──reads 18 verification* fields──▶ completion gate
                └─builds reviewer, planner, gate, repair context

AFTER
  RunController ──RunCompletionAssembly──▶ openEvaluation · planCandidateBoundary
                                        └─ compileRepairContext
        │
        └── RunCompletionAssembly (run-completion-assembly.ts)
              ├── createRunCompletionGate           the coding gate
              ├── createRunCandidateBoundaryPlanner the plan a candidate boundary binds
              ├── new TaskAcceptanceReviewer        built once, from the host's model-turn client
              └── compileVerificationRepairContext  the text the next Reason reads
```

|                                                        | Before             | After                             |
| ------------------------------------------------------ | ------------------ | --------------------------------- |
| Completion collaborators named by the Run Layer        | 18 optional fields | 1 port                            |
| Verification field names in `run-controller.ts`        | 18                 | 0                                 |
| `@caelush/verification` imports in `run-controller.ts` | 1                  | 0                                 |
| Modules that build the coding reviewer                 | 1 (the Run Layer)  | 1 (the assembly)                  |
| Production `createModelTurnExecutor` constructions     | 1                  | 1 (unchanged, now guard-enforced) |
| Production `new AgentLoop(` constructions              | 0                  | 0 (guard-enforced)                |
| Effects driven by the frozen driver                    | 3                  | 3                                 |
| Lifecycle committers                                   | 1                  | 1                                 |

---

## 4. Canonical owners

Unchanged from Phase 3E for every responsibility; see
[PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md](PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md) §1
for the full table. The one addition is the general completion gate:
`packages/agent/src/run/gates/direct-accept-completion-gate.ts`, composed by no coding host.

---

## 5. Frozen contracts

Every interface listed in the closure round is unchanged. The clause-by-clause evidence is in
[PHASE_3_FROZEN_CLAUSE_ACCEPTANCE_MAP.md](PHASE_3_FROZEN_CLAUSE_ACCEPTANCE_MAP.md).

Phase 3F added exactly one public interface — `RunCompletionAssembly` — and the Phase 3F guard asserts
it cannot commit, publish, store or parse a Run. The eighteen flat `verification*` fields remain
declared on `RunControllerDependencies` under `MIGRATION_EXECUTION_CONTRACT.md` Rule 5, and exactly one
module reads them.

---

## 6. General Agent proof

`packages/agent/test/standalone-run-execution.test.ts` imports one workspace package — `@caelush/agent`
— plus the kernel's own `@caelush/protocol` contract types. It drives the full frozen chain:

```text
USER_INPUT → TOOL_REQUESTS → Driver executes an external echo ToolTurn
           → TOOL_RESULTS  → FINAL_CANDIDATE → Driver executes the CompletionGate → ACCEPT
```

with the real `createAgentLoop`, the real `createModelTurnExecutor`, the real
`createRunExecutionDriver` and a real `ToolTurnCoordinator` this file owns. It asserts that the loop
executes no Tool, that Tool call ids/names/count/order are exactly the model's, that the adapter
receives the driver's whole frozen request, that each Reason appends its own messages once, that the
final candidate and the accepted result are different things, that a foreign identity is refused, that
an aborted signal causes no further action, and that a swapped gate changes only the decision.

```text
PROVEN      the general kernel runs, the general gate is replaceable, the whole effect chain works
            with no Workspace, Git, Runtime, Storage, Context V2 or coding verification
NOT PROVEN  a general *durable* Run service. See §8
```

The direct-accept gate itself is tested in isolation: a fresh candidate becomes
`{ type: "TEXT", text: candidateText }`, and an aborted signal returns `ERROR + retryable` rather than
accepting — the gate has no `CANCELLED` arm and never writes a status.

---

## 7. Coding production proof

`apps/daemon/src/daemon-composition.ts` composes `createCodingCompletionAssembly({...})` once and hands
the Run Layer that single port. The coding closure — plan, atomic candidate boundary, project checks,
workspace/Git freshness, task review, seal, completion CAS — is unchanged and is exercised by the
existing Phase 3E/11D suites plus a new canonical-composition test
(`packages/core/test/run-completion-assembly.test.ts`) that drives a Run to `COMPLETED` through the
converged port alone, with no flat field composed.

The strict gate cannot be bypassed: the Phase 3F guard asserts that no file under `apps/` and no file
under `packages/core/src/` names `createDirectAcceptCompletionGate` or
`DIRECT_ACCEPT_COMPLETION_GATE_ID`.

---

## 8. Explicit limitation: no general durable Run service

A general host can run the whole kernel and accept a candidate. It cannot persist a general Run to
`COMPLETED` through the current durable store, because the durable `AWAITING_VERIFICATION`
continuation and `VerifiedRunFinalResult` are Protocol shapes the storage layer validates: a Run
cannot reach `VERIFYING` without a `VerificationPlanId`, and a completion must carry a plan, a
candidate hash and a seal.

Phase 3F did **not** work around this. It did not fabricate a plan id, did not fabricate a seal or a
workspace, did not assert a type into a legal-looking snapshot, did not add a table, and did not add a
continuation discriminant. The limitation is recorded as a Run-Layer V2 target.

Minimal ContextEngine independence is likewise proven as _port independence_ only — it is not Context
V2.

---

## 9. Recovery matrix

| Scenario                                              | Result                     | Evidence                                                                                                                                                                        |
| ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider IO blocked by a failed durable commit        | no regression              | `run-agent-effect-cutover.test.ts` (`providerCalls === 0`)                                                                                                                      |
| Crash during provider execution → stale Step          | no regression              | `run-controller-recovery.test.ts`                                                                                                                                               |
| Interrupt after a Tool side effect, before settlement | no regression              | `run-controller-tool-integration.test.ts` (real close + reopen)                                                                                                                 |
| `WAITING_APPROVAL` restart                            | no regression              | `apps/cli/test/phase-12d-e2e.test.tsx` (real daemon restart)                                                                                                                    |
| `WAITING_RESOURCE` restart                            | **new**                    | `run-boundary-recovery-matrix.test.ts`: file-backed reopen, zero provider/Tool calls, continuation and progress preserved, no auto-resume, explicit Continue moves the same Run |
| `WAITING_RETRY` restart                               | **new**                    | same file: original `nextAttemptAt`, `attempt` and `maxAttempts` preserved exactly; a second early recovery spends no attempt; the failed Step is never reopened                |
| `VERIFYING` recovery reuses durable checks/evidence   | no regression              | `verification-restart.test.ts`, `run-controller-restart.test.ts`                                                                                                                |
| Cancellation during completion evaluation             | **strengthened**           | `run-completion-assembly.test.ts`: durable `CANCELLED`, `verifiedCompletions === 0`, no `finalResult`, no `run.completed`                                                       |
| Deadline during completion evaluation                 | **new**                    | `run-completion-assembly.test.ts`: durable `TIMEOUT`, `verifiedCompletions === 0`, no `run.completed`, no `run.failed`, `run.timed_out` present                                 |
| Completion CAS conflict                               | no regression, now counted | `run-completion-gate.test.ts` + the new commit counter: one candidate boundary, one verified completion, one model turn, one review                                             |
| SSE reconnect                                         | no regression              | `sse-reconnect.test.ts`, `daemon-e2e.test.ts`                                                                                                                                   |
| New Tool continuation uses the persisted policy       | **strengthened**           | `run-boundary-recovery-matrix.test.ts`: a durable policy wins over a different host policy, asserted on the text the resumed turn actually sent                                 |
| Legacy Tool continuation without a policy             | **new**                    | same file: the fixed default applies, and a host policy is consulted only when the durable record has none                                                                      |
| Retryable completion ERROR suspension                 | no regression              | `run-completion-gate.test.ts`; the settlement router's `RETRYABLE_ERROR_SUSPEND` arm is unchanged and commits nothing                                                           |

No completion retry timer, `retryAfterMs` field, automatic retry persistence or background scheduler
was added.

---

## 10. Host compatibility

| Surface                                           | Result                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| CLI interactive and non-interactive suites        | pass, unchanged                                    |
| Web session lifecycle and presentation suites     | pass                                               |
| SSE replay, reconnect and exclusive-cursor suites | pass, unchanged                                    |
| Durability of the HTTP/SSE DTOs                   | no change: no route, payload or status was touched |
| Approval, cancellation, session recovery          | pass, unchanged                                    |
| Browser smoke                                     | **repaired and passing** (§11)                     |

---

## 11. Browser smoke repair

`scripts/web-session-browser-smoke.mjs` passed `providerOverrides`, which `DaemonOptions` does not
declare. Because `startDaemon` reads only known keys, the option was **silently ignored**: the daemon
came up with no providers and the browser died later inside a Playwright timeout, at the first
`POST /api/v1/sessions` with HTTP 409 `MODEL_PROVIDER_UNAVAILABLE`.

The fixture is now what the current composition actually supports:

```text
startDaemon({ providers: [{ provider: "browser-fixture", baseUrl: "http://127.0.0.1:<port>/v1",
                            apiKey, allowedModels, modelProfiles: { "browser-fixture-model": … } }],
              defaultModel: { provider: "browser-fixture", model: "browser-fixture-model" }, … })
```

with a loopback-only, ephemeral-port `node:http` server speaking OpenAI-compatible SSE. The request
still travels the real path — `AIGateway → OpenAI-compatible adapter → @ai-sdk/openai-compatible →
fetch → HTTP → SSE` — and reaches no external network and no paid endpoint. The turn script is the one
the old in-process fixture implemented: `read_file`, `apply_patch`, a held-open stream for the
cancel/reconnect cases, and a strict-JSON acceptance review.

The script also fails fast now: it asks `/api/v1/info` which providers the daemon composed and refuses
to launch a browser when the fixture provider is absent, so a misconfiguration reports itself instead
of appearing as a browser timeout.

`pnpm build && node scripts/web-session-browser-smoke.mjs` exits 0.

---

## 12. Validation

### 12.1 Historical baseline, for contrast only

The Phase 3E report recorded 2548 passed, 2 failed, 5 skipped, both failures `RIPGREP_UNAVAILABLE`;
architecture baseline 31; readiness READY. Those were not this round's results.

### 12.2 This round

```text
pnpm build                    exit 0
pnpm typecheck                exit 0
pnpm lint                     exit 0
pnpm check:architecture:ci    exit 0
pnpm test  (run 1)            2574 passed · 1 failed · 5 skipped (2580)
pnpm test  (run 2)            2575 passed · 0 failed · 5 skipped · 446/446 files
browser smoke                 exit 0
git diff --check              exit 0
pnpm format:check             exit 1 — 777 files, pre-existing (see 12.3)
```

The two `RIPGREP_UNAVAILABLE` failures are **gone**, not skipped: ripgrep 15.2.0 is now installed and
both `search_text` integration tests pass.

Run 1's single failure was
`apps/daemon/test/web-session-lifecycle.test.ts > drives a real daemon Run to VerifiedRunFinalResult`,
erroring `The Web index asset is unavailable`. Run 2, with no source change in between, passed every
test. It is a **pre-existing test-isolation race**, not a regression:

```text
apps/web/test/browser-safe-build.test.ts   runs a real `cmd /c node_modules\.bin\vite.cmd build`
                                           in apps/web; vite empties apps/web/dist before writing it
apps/daemon/test/web-session-lifecycle.test.ts  reads apps/web/dist/index.html
```

Both files are byte-identical to the baseline (`git status` clean, `git diff --stat <base> --` empty)
and the baseline already contained the `vite build` invocation. The daemon test also passes on its own.
It is recorded rather than worked around: this round did not weaken the assertion, skip the test,
retry it, or serialise the two suites.

### 12.3 Repository-wide `format:check`

`pnpm format:check` fails for 777 files, including files this round never touched — `README.md`,
`pnpm-workspace.yaml`, `playwright.config.mjs`. The cause is environmental: `core.autocrlf=true`
(`git config`) checks files out with CRLF while Prettier expects LF, so `prettier --check` reports
every file. `prettier <file>` on an untouched file differs only in line endings.

Every file this round created or modified was formatted and passes:

```text
npx prettier --check <the 22 changed .ts/.mjs/.json/.md files>
  → All matched files use Prettier code style!
```

No unrelated file was reformatted.

---

## 13. Architecture gates

```text
                              before      after
target packages               7 / 7       7 / 7
legacy migration mappings     10 / 10     10 / 10
frozen migration debt         31          31         (no growth)
new violations                0           0
stale baseline entries        0           0
private production imports    0           0
cross-workspace imports       0           0
readiness                     READY       READY
```

The baseline did not grow and was not regenerated. No entry was removed, because this round resolved
no dependency edge — it moved code inside packages that already had the edge.

---

## 14. Compatibility inventory

Ten declared surfaces, each with a reason, a consumer set, a dependency direction, an explicit
non-authority and an exit condition:
[PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md](PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md) §3.
Nine of them are unchanged from Phase 3E; the new one is the flat `verification*` group's compatibility
projection. One known divergence is recorded rather than hidden (§3.1 of that document).

---

## 15. Remaining target mapping

Context V2, Tool System V2, Security V2, Coding Agent V2, Verification V2, Memory V2, Message/Session
V2, MCP, Skills, Browser Agent, Computer Use, Web Search, Multi-Agent, Sub-Agent, parallel Tool
execution and a general durable Run store all remain owned by their own subsystems. The per-target
table is
[PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md](PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md) §5.
This report proposes no next round.

---

## 16. Behaviour changes

**None** in production behaviour. Phase 3F is a refactor: no Run semantic, Tool lifecycle, model
invocation, approval semantic, durable event sequence, session behaviour or error contract changed.

Two non-production changes are deliberate and stated:

```text
1. scripts/web-session-browser-smoke.mjs   a test fixture, repaired to use the supported seam
2. an optional read of /api/v1/info        used by the fixture's own fail-fast check
```

One behaviour is _newly covered_ rather than changed: recovery of a `WAITING_RESOURCE` or
`WAITING_RETRY` Run across a real storage reopen was always implemented and is now tested.

---

## 17. Git delivery

See the closing section of the branch report in the round output; the base SHA is
`bbc2ebd007527aace7535b80831f914c67fde140` and the branch is
`deepseek/architecture-v2-phase-3f-agent-loop-closure`. Remote parity and the clean-checkout
verification are recorded in the round report.

---

## 18. Verdict

```text
Phase 3 Agent Loop execution-chain migration and its Phase 3F closure: COMPLETE
```

with the two recorded limitations of §8 (no general durable Run service) and §12.3 (repository-wide
`format:check` is a pre-existing CRLF condition), and one recorded pre-existing flake (§12.2).

Not claimed: the whole Architecture V2, a Coding Agent package migration, Context V2, Tool System V2, a
general durable agent product, "all tests pass", or "the browser regression suite is green" beyond the
single smoke this repository has.
