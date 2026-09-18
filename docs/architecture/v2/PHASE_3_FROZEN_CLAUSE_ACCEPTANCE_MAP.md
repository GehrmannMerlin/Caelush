# Caelush Architecture V2 — Phase 3 Frozen-Clause Acceptance Map

This document maps every clause the Phase 3 closure round is measured against onto the code and test
that satisfies it, and classifies each as one of:

```text
SATISFIED                  true today, with evidence
PHASE_3F_REQUIRED          this round had to make it true, and did
OWNED_BY_LATER_SUBSYSTEM   a real Architecture V2 target that Phase 3 does not own
BLOCKED                    not true, and nothing in this round could make it true
```

---

## 0. Source of the clause set

The Interface Freeze document (`Caelush_Agent_Loop_V2_Current_to_Target_Interface_Freeze*.md`) is **not
present in this repository**. `git ls-files` matches no file of that name under any suffix or
bracketed variant, and `docs/architecture/v2/` contains only the Phase 1 and Phase 2 documents.

The clause set below is therefore the one the closure round states, cross-checked clause by clause
against **the frozen contracts as they exist in source**:

```text
packages/agent/src/loop/types.ts                       kernel types
packages/agent/src/loop/agent-loop.ts                  advance()
packages/agent/src/loop/ports/*.ts                     admission, durable boundary
packages/agent/src/run/directive.ts                    coordinator / directive vocabulary
packages/agent/src/run/run-execution-driver.ts         effect execution
packages/agent/src/run/ports/completion-gate.ts        the completion contract
packages/agent/src/run/continuation/continuation.ts    durable continuation discriminants
packages/agent/test/contracts/phase-3{a,b,c}-*.test.ts type-level freeze, fails `pnpm typecheck`
tests/architecture/phase-3{a,b,c,d,e,f}-*.test.ts      structural guards
```

No clause below is asserted on the strength of a document that cannot be read.

---

## 1. Frozen interfaces — not renamed, not extended, not re-semanticised

| Clause                                                  | Status    | Evidence                                                                                               |
| ------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `AgentLoopAdvanceInput` unchanged                       | SATISFIED | `loop/types.ts`; `packages/agent/test/contracts/phase-3a-frozen-contracts.test.ts`                     |
| `AgentLoopAdvanceResult` unchanged (four discriminants) | SATISFIED | same                                                                                                   |
| `AgentTurnInput` unchanged                              | SATISFIED | same                                                                                                   |
| `AgentDecision` unchanged                               | SATISFIED | `loop/decision/decision.ts`; `AGENT_DECISION_TYPES`                                                    |
| `ContextEnginePort` unchanged                           | SATISFIED | `loop/context/context-engine-port.ts`; `context-provider-conformance.test.ts`                          |
| `ModelTurnExecutor` unchanged                           | SATISFIED | `loop/turn/model-turn-executor.ts`                                                                     |
| `ModelRequestAdmissionPort` unchanged                   | SATISFIED | `loop/ports/model-request-admission.ts`                                                                |
| `ModelTurnBoundaryPort` unchanged                       | SATISFIED | `loop/ports/model-turn-boundary.ts`; `phase-3c` guard                                                  |
| `RunExecutionCoordinator` unchanged                     | SATISFIED | `run/run-execution-coordinator.ts`; `run-execution-coordinator.test.ts`                                |
| `RunExecutionDirective` unchanged (six discriminants)   | SATISFIED | `run/directive.ts`; `RUN_EXECUTION_DIRECTIVE_KINDS`                                                    |
| `RunExecutionDriver` unchanged                          | SATISFIED | `run/run-execution-driver.ts`; `run-execution-driver.test.ts`                                          |
| `RunExecutionDriverDependencies` unchanged              | SATISFIED | same                                                                                                   |
| `RunExecutionEffectContext` unchanged                   | SATISFIED | same                                                                                                   |
| `RunExecutionEffectResult` unchanged                    | SATISFIED | `run/effect-result.ts`; `RUN_EXECUTION_EFFECT_KINDS`                                                   |
| `RunTransitionPlanner` unchanged                        | SATISFIED | `run/run-transition-planner.ts`; `run-transition-planner.test.ts`                                      |
| `CompletionGate` unchanged                              | SATISFIED | `run/ports/completion-gate.ts`; `phase-3e` guard asserts the request carries no host field             |
| `CompletionGateInput` unchanged                         | SATISFIED | same; the guard forbids `workspace`/`runtime`/`store`/`reviewer`/…                                     |
| `CompletionGateDecision` unchanged (exactly four arms)  | SATISFIED | same; the guard forbids `DEFER`, `SUSPEND`, `retryAfterMs`                                             |
| `AgentCompletionResult` unchanged                       | SATISFIED | same; the general gate returns a plain `{ type, text }`                                                |
| `CompletionRepairRequest` unchanged                     | SATISFIED | same                                                                                                   |
| Durable continuation discriminants unchanged            | SATISFIED | `run/continuation/continuation.ts`; `RUN_CONTINUATION_TYPES`; `run-continuation-compatibility.test.ts` |

Phase 3F added exactly one public interface — `RunCompletionAssembly` — and it is an internal assembly
seam. The Phase 3F guard asserts the assembly cannot commit, publish, store or parse a Run.

---

## 2. Structural invariants

| #   | Clause                                                              | Status    | Evidence                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `advance()` is the only general Reason entry                        | SATISFIED | `loop/agent-loop.ts`; the Phase 3F guard asserts exactly three `createRunExecutionDriver(` sites and that the Agent effect binds `agentLoop: loop`                                         |
| 2   | `AgentLoop` executes no Tool                                        | SATISFIED | `standalone-run-execution.test.ts` asserts the echo adapter is untouched when the loop returns a Tool request                                                                              |
| 3   | `AgentLoop` writes no Run state                                     | SATISFIED | kernel source has no store; `standalone-kernel.test.ts` imports only `@caelush/agent`                                                                                                      |
| 4   | Step identity is allocated by the Run layer                         | SATISFIED | `run-agent-execution.ts` `createStepId`; `nextAgentStepSequence`                                                                                                                           |
| 5   | The durable boundary precedes model I/O                             | SATISFIED | `run-model-turn-boundary.ts`; `phase-3c` guard; `run-agent-effect-cutover.test.ts` "never reaches the provider when the durable open-Step commit is refused" asserts `providerCalls === 0` |
| 6   | The coordinator keeps deterministic decision duty                   | SATISFIED | `run-execution-coordinator.test.ts` decision table                                                                                                                                         |
| 7   | The driver executes effects and commits no lifecycle                | SATISFIED | `run-execution-driver.ts` has no store dependency                                                                                                                                          |
| 8   | `RunController` keeps lifecycle commit authority                    | SATISFIED | Phase 3F guard: `commitCandidateBoundary` / `commitVerifiedCompletion` remain the only completion writes                                                                                   |
| 9   | Completion decisions are only ACCEPT/REPAIR/REJECT/ERROR            | SATISFIED | `phase-3e` guard on the frozen union                                                                                                                                                       |
| 10  | No `DEFER`/`SUSPEND`/`CANCELLED` completion decision                | SATISFIED | same; the general gate's aborted path returns `ERROR + retryable`, and the guard asserts it contains no `"CANCELLED"`                                                                      |
| 11  | No host field added to `CompletionGateInput`                        | SATISFIED | `phase-3e` guard; Phase 3F adds the host facts behind `RunCompletionAssembly` instead                                                                                                      |
| 12  | `VerificationPlan` stays out of the general Run snapshot            | SATISFIED | `phase-3e` guard on `run-execution-store.ts`                                                                                                                                               |
| 13  | Core-private mutable observation stays out of the general contract  | SATISFIED | `phase-3e` + Phase 3F guards scan every `packages/agent/src` file for `CompletionGateObservation`                                                                                          |
| 14  | Historical continuation encodings unmodified                        | SATISFIED | `run-continuation-compatibility.ts` + `agent-continuation-schema.ts`; Phase 3F touched neither                                                                                             |
| 15  | `FINAL_CANDIDATE` never equals `COMPLETED`                          | SATISFIED | `run-completion-gate.ts`; `completion-authority.ts`; `standalone-run-execution.test.ts` asserts the candidate carries no `COMPLETED`                                                       |
| 16  | No subsystem gets arbitrary Run write access via callback           | SATISFIED | the assembly receives the notifier and the persistence port _per evaluation_; no callback writes a Run                                                                                     |
| 17  | No `as any`, fabricated ID or empty object bypasses identity checks | SATISFIED | the gate validates identity/Step/candidate; `standalone-run-execution.test.ts` asserts a foreign identity is refused                                                                       |
| 18  | No lifecycle path is chosen by exception message text               | SATISFIED | `phase-3e` guard asserts the settlement router contains no `.message` and no `catch`                                                                                                       |
| 19  | No new target → legacy dependency                                   | SATISFIED | `pnpm check:architecture:ci`: baseline 31, new violations 0                                                                                                                                |
| 20  | No architecture-violation baseline growth                           | SATISFIED | same: 31 before, 31 after, stale entries 0                                                                                                                                                 |

---

## 3. The closure round's own success conditions

| Condition                                                                 | Status                            | Evidence                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production uses only the new Agent Loop chain                             | PHASE_3F_REQUIRED — done          | `run-controller.ts` composes `createRunAgentLoop` over the frozen kernel; the daemon builds one `ModelTurnExecutor`; the Phase 3F guard asserts no production file builds the legacy facade                                                                                                    |
| `RunController` no longer assembles concrete Coding acceptance            | PHASE_3F_REQUIRED — done          | 0 `verification*` field reads, 0 `new TaskAcceptanceReviewer(`, 0 `@caelush/verification` imports in `run-controller.ts` (guard-enforced)                                                                                                                                                      |
| No hidden production call to the legacy facade                            | PHASE_3F_REQUIRED — done          | guard: zero `new AgentLoop(` in production, zero `createLegacyModelTurnExecutor(` outside its own declaration and the public re-export                                                                                                                                                         |
| General Agent usable without Workspace/Git/Runtime/Coding Verification    | PHASE_3F_REQUIRED — done, in part | `standalone-run-execution.test.ts`: loop + real executor + real driver + echo Tool adapter + direct-accept gate, importing only `@caelush/agent`. Proves kernel independence, gate replaceability and the full effect chain. It does **not** prove a general _durable_ Run service — see §5    |
| Coding production path still requires strict acceptance                   | PHASE_3F_REQUIRED — done          | the daemon composes the coding assembly; the Phase 3F guard forbids any coding host from naming the accept-directly gate                                                                                                                                                                       |
| Recovery, approval, cancellation, retry, resource control stay compatible | PHASE_3F_REQUIRED — done          | `run-boundary-recovery-matrix.test.ts` (file-backed reopen for `WAITING_RESOURCE`, `WAITING_RETRY`, the observation-policy fallback); `run-completion-assembly.test.ts` (cancel and timeout during a completion commit nothing); the pre-existing Phase 10A–10D suites are unchanged and green |
| The legacy facade is not a second Reason implementation                   | SATISFIED                         | `agent-loop.ts` delegates to `createAgentLoop`; Phase 3F additionally moved its one helper out of the legacy executor's implementation file                                                                                                                                                    |
| Compatibility layers are declared with a purpose and an exit condition    | PHASE_3F_REQUIRED — done          | `PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md` §3 lists ten surfaces with consumer, direction, non-authority and exit condition                                                                                                                                                       |
| Browser smoke reaches the production daemon again                         | PHASE_3F_REQUIRED — done          | `scripts/web-session-browser-smoke.mjs` now composes a loopback `node:http` OpenAI-compatible SSE provider through the supported `providers` seam                                                                                                                                              |

---

## 4. Things this round explicitly did NOT attempt

```text
Message System V2 · Session V2 · Context V2 rewrite · a new Context summary algorithm
Memory automatic extraction closure · the Tool System V2 package split
the Coding Agent package consolidation · MCP · Skills · Browser Agent · Computer Use
Web Search · Multi-Agent · Sub-Agent · true parallel Tool execution · Steering UI
a new Verification algorithm · new database tables or schema migrations
HTTP/SSE public protocol redesign · CLI/Web interaction redesign
auto-update · production deployment
```

None of these is claimed as complete anywhere in this round's output.

---

## 5. BLOCKED / not proven, stated plainly

| Item                                                                | Status                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A general **durable** Run service with no verification-shaped state | BLOCKED (by frozen encoding) | the durable `AWAITING_VERIFICATION` continuation and `VerifiedRunFinalResult` are Protocol types the storage layer validates. A general Run cannot reach `VERIFYING` without a `VerificationPlanId`, and fabricating one — or asserting a type into a legal-looking snapshot — is exactly what the closure round forbids. Phase 3F therefore proves the general kernel and the replaceable gate, and records this as a Run-Layer V2 target rather than faking it |
| "All tests pass" as an absolute statement                           | BLOCKED (environment)        | the two ripgrep-dependent tests failed before this round because no `rg` executable existed on the host. Phase 3F installed ripgrep 15.2.0 and they pass. The repository's `format:check` still fails repo-wide on Windows because `core.autocrlf=true` checks out CRLF and Prettier expects LF; this is pre-existing and affects untouched files such as `README.md`. See the Phase 3F report §12                                                               |
| The whole Architecture V2 migration                                 | OWNED_BY_LATER_SUBSYSTEM     | Context, Tool, Security, Memory, Verification, Coding Agent, Message/Session — see the inventory §5                                                                                                                                                                                                                                                                                                                                                              |
