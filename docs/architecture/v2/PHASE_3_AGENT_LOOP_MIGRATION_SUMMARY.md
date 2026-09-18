# Caelush Architecture V2 — Phase 3 Agent Loop Migration Summary

```text
Phase 3A  kernel contracts and dependency boundary
Phase 3B  AgentLoop.advance() as the general Reason kernel
Phase 3C  production Agent execution into the Run Layer's frozen driver
Phase 3D  real ToolTurn behind the frozen driver
Phase 3E  real CompletionGate behind the frozen driver
Phase 3F  convergence, compatibility closure and migration finish
```

Phase 3 migrates **one execution chain**: how a durable Run reasons, executes Tools, and decides that
a final candidate may become its result. It does not migrate the Context, Tool, Security, Memory or
Coding Agent packages; §6 records where those still stand.

---

## 1. What each round produced

| Round | Result                                                                                                                                                                                                                                                                                                                                                        | Where it lives now                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 3A    | The general kernel's types, ports and dependency boundary: identity, turn reference, turn input, decisions, `AgentLoop.advance()`, the model request builder, the admission and durable-boundary ports, the transient stream, the frozen `ModelTurnExecutor` union                                                                                            | `packages/agent/src/loop/**`                                                 |
| 3B    | `advance()` implemented as a pure Reason kernel: model execution, decision classification and the Context port separated from the loop                                                                                                                                                                                                                        | `packages/agent/src/loop/agent-loop.ts`                                      |
| 3C    | Production Agent execution moved into `RunExecutionCoordinator` → `RunExecutionDriver` → `RunTransitionPlanner`, with Run-layer Step allocation and a durable boundary before provider I/O                                                                                                                                                                    | `packages/agent/src/run/**`, `packages/core/src/run-agent-execution.ts`      |
| 3D    | The real Tool turn behind the frozen driver, preserving sequential execution, Tool persistence, approval, resource governance, result correlation and uncertain-side-effect recovery                                                                                                                                                                          | `packages/core/src/run-tool-turn-coordinator.ts`                             |
| 3E    | The real completion gate behind the frozen driver: acceptance workflow out of the controller, plan bound to the candidate, atomic candidate boundary, a Core-private completion persistence port, freshness recheck, sealed result, completion CAS, cancellation/timeout priority, typed settlement, retryable-ERROR suspension, explicit-Run-identity review | `packages/core/src/run-completion-gate.ts`, `run-completion-verification.ts` |
| 3F    | Convergence and closure: one production Reason entry, one model authority, one completion composition, one lifecycle committer, declared compatibility with an exit condition, standalone general-agent proof, browser fixture repaired                                                                                                                       | see §3                                                                       |

---

## 2. The production call graph after Phase 3F

```text
Daemon composition root (apps/daemon/src/daemon-composition.ts)
  ├── AISubsystem → AIGateway → ApiAdapter → provider transport
  ├── createModelTurnExecutor({ gateway })                 ← the only construction
  ├── ToolRegistry → ToolDispatcher → ToolBatchCoordinator
  ├── createLegacyContextRuntimeAdapter(...)               ← satisfies the frozen ContextEnginePort
  ├── createCodingCompletionAssembly({...})                ← the only coding completion composition
  └── RunController({
        agentExecution, executionStore, completionStore, events, configResolver,
        toolCoordinator, clock, eventIdFactory, approvals, scopes, deadlineRegistry,
        retryRegistry, resources, budget, resourceGovernance, completion, onVerifiedCompletion })

RunController.start / recover / submitToolResults / resolveApproval / continueResourceGuard
  │
  ├── load() · withLock() · termination authority (cancellation intent, deadline, budget, maxSteps)
  │
  └── driveRunExecutionLocked(snapshot, mode)
        │
        └── coordinator.next(snapshot, now)                ← the only routing authority
              │
              ├── ADVANCE_AGENT
              │     Run-layer Step allocation → createRunExecutionDriver({ agentLoop: REAL })
              │       → AgentLoop.advance() → ModelTurnExecutor → gateway
              │
              ├── EXECUTE_TOOL_BATCH
              │     createRunExecutionDriver({ toolTurns: REAL })
              │       → run-scoped Tool turn adapter → ToolBatchCoordinator → ToolDispatcher
              │
              ├── EVALUATE_COMPLETION
              │     completionAssembly.openEvaluation({ snapshot, mode, signal,
              │                                        persistence, notifyCommitted })
              │       → createRunExecutionDriver({ completionGate: REAL })
              │         → coding completion gate → verification workflow → decision
              │
              └── FINALIZE / SUSPEND / RETURN_TERMINAL
                    termination authority settles, or the Run waits on its durable boundary
```

Every effect settles through the Run Layer's typed settlement router, and every lifecycle write goes
through `RunController.commit` / `commitCandidateBoundary` / `commitVerifiedCompletion`.

---

## 3. What Phase 3F closed

| Closure                                     | Before                                                                                                                 | After                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Completion composition in the Run Layer     | 18 optional `verification*` dependency fields read one by one; the reviewer built inside `run-controller.ts`           | one `RunCompletionAssembly` port; the flat group converted by one declared compatibility module                                                                          |
| `run-controller.ts` reach into verification | imports `@caelush/verification`, reads 18 verification fields                                                          | 0 fields, 0 imports (guard-enforced)                                                                                                                                     |
| General-agent standalone proof              | the Reason kernel alone                                                                                                | the whole frozen Run execution contract: loop + executor + driver + coordinator + echo Tool adapter + direct-accept gate, in one file that imports only `@caelush/agent` |
| Replaceable completion gate                 | the coding gate existed, the general one did not                                                                       | `createDirectAcceptCompletionGate` in the kernel; the coding daemon may never name it (guard-enforced)                                                                   |
| Legacy error mapping                        | `agent-loop.ts` imported the legacy executor _implementation_ for one pure function                                    | the mapping has its own module; the facade re-exports it                                                                                                                 |
| Browser smoke fixture                       | passed `providerOverrides`, a key the production daemon has not accepted for several phases (silently ignored)         | a loopback-only ephemeral-port `node:http` OpenAI-compatible SSE server wired through the supported `providers` seam                                                     |
| Recovery matrix coverage                    | `WAITING_RESOURCE` and `WAITING_RETRY` restarts and the observation-policy fallback were uncovered at restart fidelity | file-backed close/reopen tests for all three, plus timeout-during-completion and cancel-during-completion                                                                |
| Architecture guards                         | Phase 3A–3E guards                                                                                                     | plus a Phase 3F guard set (§ below)                                                                                                                                      |

### 3.1 Phase 3F architecture guards

Added in `tests/architecture/phase-3f-agent-loop-closure.test.ts`:

```text
the Run Layer names one completion port and no verification field
the assembly commits nothing and holds no store or bus
exactly one module declares the coding completion assembly
the daemon selects the converged port and none of the flat fields
the accept-directly gate carries no host fact and no coding host may name it
the kernel depends only on @caelush/ai and @caelush/protocol
no production file builds the legacy AgentLoop or the throwing model-turn facade
exactly one production file constructs the frozen ModelTurnExecutor
three effects, three driver constructions, one lifecycle committer
```

Three pre-existing guards were updated rather than deleted, because the code they protect moved:
`phase-2c` (the kernel's exported symbol list grew by the general gate), `phase-3c` (the
gate-shaped-object carve-out list gained the composition seam and the general gate), and `phase-3e`
(the reviewer's construction site moved from the Run Layer to the assembly; the factory call count is
still exactly one). Each kept its invariant and re-pointed at the new canonical location.

---

## 4. Frozen contracts that did not change

```text
AgentLoopAdvanceInput · AgentLoopAdvanceResult · AgentTurnInput · AgentDecision
ContextEnginePort · ModelTurnExecutor · ModelRequestAdmissionPort · ModelTurnBoundaryPort
RunExecutionCoordinator · RunExecutionDirective · RunExecutionDriver
RunExecutionDriverDependencies · RunExecutionEffectContext · RunExecutionEffectResult
RunTransitionPlanner · CompletionGate · CompletionGateInput · CompletionGateDecision
AgentCompletionResult · CompletionRepairRequest · the durable continuation discriminants
```

Phase 3F added **one** public interface — `RunCompletionAssembly` — and it is an internal assembly
seam: it does not widen any of the above, and the guard set asserts that the assembly cannot commit,
publish or store.

---

## 5. Behaviour

Phase 3F is a refactor. No Run semantics, Tool lifecycle, model invocation behaviour, approval
semantic, durable event sequence, session behaviour or error contract changed. The one deliberate
observable change is in **test infrastructure**: `scripts/web-session-browser-smoke.mjs` no longer
passes an option the daemon ignores, and now drives a real loopback fake provider instead.

---

## 6. Where the remaining Architecture V2 work stands

Phase 3 closed the Agent Loop _execution chain_. Everything below is still owned by its own subsystem
and was not started, promised or scheduled by Phase 3:

```text
Context V2            @caelush/context → agent + coding-agent split; summary/compaction algorithm
Tool System V2        @caelush/tools → agent (contracts) + coding-agent (built-ins) split
Security V2           @caelush/security → agent + coding-agent + runtime split
Coding Agent V2       the @caelush/core coding side consolidated into @caelush/coding-agent
Verification V2       @caelush/verification → agent + coding-agent split
Memory V2             automatic extraction closure
Message/Session V2    new durable encodings
MCP · Skills · Browser Agent · Computer Use · Web Search · Multi-Agent · Sub-Agent
True parallel Tool execution
A general durable Run store with no verification-shaped continuation
```

The exact per-target mapping is in
[PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md](PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md) §5.
