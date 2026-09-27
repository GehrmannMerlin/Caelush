# Caelush Architecture V2 — Phase 8F Final Acceptance

## Final Acceptance, Compatibility Retirement & Architecture Seal

This document records the Phase 8F acceptance evidence for Context Compaction
V2. Phase 8F is an acceptance and retirement round only. It adds no Phase 8G,
new compaction feature, branch summary, vector memory, provider-specific
tokenizer, or second authority.

## 1. Phase identity and corrected baseline

```text
Phase 8F — Context Compaction V2
Final Acceptance, Compatibility Retirement & Architecture Seal
```

The Phase 8E report incorrectly named the following as the Phase 8F repository
base:

```text
db367821378f30c9aa9280a32ef724d605b773ac
```

That SHA is the Phase 8E production-code cutover commit. The two legal
documentation commits after it were `0fc62fced46825bda5ce7d14cd85a95f4d455b38`
and `90ce4367d7e827001f5a6cac27e02ca5d1bd12ed`. Therefore the actual Phase 8F
repository base is:

```text
90ce4367d7e827001f5a6cac27e02ca5d1bd12ed
```

No history rewrite, reset, rebase, restore, or force push was performed.

Initial preflight and final handoff both used the direct `main` workflow.

```text
initial branch      = main
initial HEAD        = 90ce4367d7e827001f5a6cac27e02ca5d1bd12ed
initial origin/main = 90ce4367d7e827001f5a6cac27e02ca5d1bd12ed
initial worktree    = clean
```

## 2. Consumer audit and compatibility retirement

Before the change, the compatibility scan found:

| Surface                                                    | Before                                                                 | Evidence                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Production Agent consumer of `summarizationRunner`         | `ContextEngine` option, local variable, and compatibility factory call | `packages/agent/src/context/engine/context-engine.ts`                    |
| Production consumer of `createContextSummarizerFromRunner` | `ContextEngine` only                                                   | `packages/agent/src/context/engine/context-engine.ts`                    |
| Adapter file                                               | present                                                                | `packages/agent/src/context/compaction/context-summary-compatibility.ts` |
| Test fixtures                                              | Phase 7F, Phase 8C, Phase 8D fixtures used `summarizationRunner`       | the three affected Agent test files                                      |
| Public export of compatibility adapter                     | none                                                                   | Agent root/context export audit                                          |

After the change:

```text
production summarizationRunner consumers = 0
production createContextSummarizerFromRunner consumers = 0
production context-summary-compatibility consumers = 0
final Engine option = summarizer?: ContextSummarizerPort
```

Removed:

- `V2ContextEngineOptions.summarizationRunner`.
- The import and fallback construction in `context-engine.ts`.
- `packages/agent/src/context/compaction/context-summary-compatibility.ts`.
- The old option from Phase 7F, Phase 8C, and Phase 8D test fixtures.
- The Phase 8C fallback fixture's direct `FALLBACK_REQUIRED` runner result; it
  now tests the final API by making the injected summarizer fail and allowing
  the Coordinator-owned runner to classify the fallback.

Retained intentionally:

- `ContextSummarizationRunner`.
- `createContextSummarizationRunner()`.
- `ContextSummaryExecutionResult`.

These are not transition compatibility. The Agent-owned Coordinator uses them
for the single semantic attempt, validation, cancellation propagation, and
fallback classification.

## 3. Stale guard migration

### Phase 8B

The obsolete assertion that later authorities must not exist was removed. The
Phase 8B guard now proves that incremental modules remain Agent-owned and
provider-neutral, publish their frozen contracts, and remain free of Storage,
daemon, raw-artifact, and attempt-state authority. It also proves that the
final Coordinator consumes the incremental resolver, checkpoint budget, and
gain evaluator while AgentLoop retains the overflow path.

### Phase 8D

The obsolete assertion that Engine must not contain Coordinator or Recovery was
removed. The guard now proves the final composition explicitly:

```text
Engine → createContextCompactionCoordinator
Engine → createContextRecoveryPlanner
Engine → shared buildPreparedProjectionWithoutCompaction
```

The durable invariants remain unchanged: Agent owns rebuild and digest,
Storage owns persistence and event proof, there is no attempt table/state
machine, V2 does not call `updateTokensAfter`, and AgentLoop owns overflow
recovery.

### Phase 2C acceptance correction

The exact Agent root export guard was also stale relative to the already-legal
8E public contracts. Its expected set was updated to include the Coordinator,
Recovery, recovery application, criticality, tail policy, and typed summary
infrastructure exports. This is a test expectation correction only; no new
public authority was introduced in Phase 8F.

## 4. Final architecture guard

`tests/architecture/phase-8f-context-compaction-final-acceptance.test.ts`
contains the final architecture seal. It covers:

| Invariant                                 | Production evidence                                                                                                                  | Result |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| One compaction authority                  | Engine composes `createContextCompactionCoordinator`; Coordinator owns lifecycle                                                     | PASS   |
| One recovery authority                    | Recovery planner is Agent-owned; daemon has no recovery planner/policy authority                                                     | PASS   |
| No summary compatibility                  | No Engine option, factory, or adapter file remains                                                                                   | PASS   |
| Runner retained for Coordinator internals | Coordinator still constructs `createContextSummarizationRunner`                                                                      | PASS   |
| Raw artifact boundary                     | semantic sources, facts, digest, and Coordinator contain no raw-artifact access; only forced materialization reprojects observations | PASS   |
| No event control path                     | Coordinator has no EventHub/subscriber control and only notifies after commit                                                        | PASS   |
| No attempt state machine                  | no `ContextCompactionAttempt` or `context_compaction_attempts` authority                                                             | PASS   |
| Immutable V2 checkpoint path              | Engine has no `updateTokensAfter`; rebuild estimate becomes `tokensAfter` before commit                                              | PASS   |
| AgentLoop overflow authority              | Loop has exactly one forced recovery path and no third attempt                                                                       | PASS   |
| Frozen Agent public surface               | final contracts remain available from `@caelush/agent`                                                                               | PASS   |

## 5. Frozen Definition of Done evidence matrix

| Frozen invariant                                              | Production source                                    | Test evidence                                                                              | Result |
| ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| Pressure is evaluated before each model turn                  | `context-engine.ts`, `context-pressure-evaluator.ts` | Phase 8A foundation pressure tests; AgentLoop advance tests                                | PASS   |
| Effective budget includes request overhead                    | policy and request-overhead estimator                | `phase-8a-context-compaction-foundation.test.ts`, `phase-7f-engine.test.ts`                | PASS   |
| 75% proactive / 90% emergency thresholds                      | `context-policy.ts` and pressure evaluator           | Phase 8A threshold and trigger cases                                                       | PASS   |
| Hysteresis target is preserved                                | pressure and policy target calculation               | Phase 8A post-compaction hysteresis test                                                   | PASS   |
| Full Turn preferred                                           | cut-point selector                                   | Phase 8A `prefers a full Turn boundary`                                                    | PASS   |
| Huge Turn splits only at safe protocol boundaries             | cut-point selector and coverage                      | Phase 8A huge Turn split; Phase 8B residual coverage                                       | PASS   |
| ToolCall/ToolResult atomicity                                 | history index and cut validation                     | Phase 8A closed protocol, multi-tool, and OPEN protocol tests; Phase 8D candidate coverage | PASS   |
| OPEN protocol protected                                       | history status and planner                           | Phase 8A `protects an OPEN protocol and the current Turn`; Phase 8D candidate coverage     | PASS   |
| Current intent protected                                      | current Turn selection                               | Phase 8A current Turn test; production E2E                                                 | PASS   |
| Incremental A→B→C coverage                                    | incremental resolver/coverage                        | Phase 8B cumulative A-to-B-to-C range test                                                 | PASS   |
| V1 is readable but not a V2 predecessor                       | incremental resolver and repository                  | Phase 8B legacy-state test; Storage V2 mixed replay test                                   | PASS   |
| One semantic call                                             | Coordinator and summary runner                       | Phase 8C one semantic attempt; Phase 8E coordinator one-call test                          | PASS   |
| Tools disabled for semantic summary                           | daemon summary adapter                               | `ai-context-summarizer-adapter.test.ts`                                                    | PASS   |
| Only STOP semantic output is accepted                         | semantic validator                                   | Phase 8C finish-reason and malformed-output tests                                          | PASS   |
| Summary failure falls back deterministically                  | Coordinator and deterministic builder                | Phase 8C degraded fallback; Phase 8E Coordinator fallback/infra tests                      | PASS   |
| Cancellation aborts without fallback/commit                   | runner and Coordinator                               | Phase 8C cancellation; Phase 8E cancellation; Engine durability abort tests                | PASS   |
| Semantic claims do not become durable authority               | validator/enricher/facts builder                     | Phase 8C authority-neutral and deterministic-authority tests                               | PASS   |
| Raw Tool output excluded from semantic source                 | serializer and coding facts projector                | Phase 8B summary source; Phase 8C coding facts and architecture guards                     | PASS   |
| Tentative rebuild precedes commit                             | Coordinator/rebuilder/Engine                         | Phase 8D Engine durability and rebuilder tests                                             | PASS   |
| `tokensAfter` equals materialized estimate before persistence | shared production build path                         | Phase 8D `persists the materialized estimate`                                              | PASS   |
| Oversize candidate is not committed                           | Coordinator fit gate                                 | Phase 8D Engine durability; Phase 8E Coordinator candidate-too-large test                  | PASS   |
| Digest is deterministic and range-bound                       | digest builder                                       | Phase 8D digest tests                                                                      | PASS   |
| Atomic checkpoint/event commit                                | Storage commit store                                 | Storage compaction commit rollback, sequence, and ownership tests                          | PASS   |
| Idempotent replay and conflict rejection                      | checkpoint repository/commit store                   | Storage repository and commit replay/conflict tests                                        | PASS   |
| Restart replay preserves identity                             | Storage repositories                                 | Storage restart/replay tests                                                               | PASS   |
| Forced recovery fixed order                                   | recovery planner                                     | Phase 8E planner fixed-order test                                                          | PASS   |
| Protected items are not silently reduced                      | recovery application                                 | Phase 8E recovery application protection test                                              | PASS   |
| Auxiliary budget uses `CONTEXT_COMPACTION`                    | Storage budget port/ledger                           | budget-ledger and run-budget tests                                                         | PASS   |
| Admission precedes provider I/O                               | daemon budgeted summarizer                           | Phase 8E budget admission/denial tests                                                     | PASS   |
| Settlement uses actual usage and conservative closure         | daemon/storage budget path                           | Phase 8E settlement/failure tests                                                          | PASS   |
| Denial causes zero provider calls                             | budget adapter                                       | Phase 8E `does not call the provider when denied`                                          | PASS   |
| Auxiliary work has zero Step/Tool delta                       | Run budget projection                                | Storage run-budget test                                                                    | PASS   |
| Main overflow has exactly one forced retry                    | AgentLoop                                            | AgentLoop `performs exactly one forced recovery`                                           | PASS   |
| Second overflow exhausts and third call is absent             | AgentLoop                                            | AgentLoop `fails as exhausted after a second overflow`                                     | PASS   |
| No event-driven compaction                                    | Coordinator/Hub boundary                             | Phase 8F final guard and source audit                                                      | PASS   |
| No branch summary or new routing framework                    | production scan                                      | Phase 8F source audit and final non-goal review                                            | PASS   |

## 6. Pressure, cut, protocol, intent, and incremental evidence

The Phase 8A tests cover below-proactive, exact proactive, between proactive
and emergency, exact emergency, forced provider overflow, no compressible
history, and post-compaction hysteresis. Request overhead is included in the
input estimate and the thresholds remain 75% and 90%; Phase 8F did not tune
them.

Safe-cut evidence covers multiple complete Turns, a single oversized Turn,
closed ToolProtocolUnit boundaries, multi-tool Assistant completeness, OPEN
protocol protection, and current user intent retention. The incremental tests
exercise the actual cumulative chain:

```text
A: 1..100
B: previous A + raw 101..160 → cumulative 1..160
C: previous B + raw 161..220 → cumulative 1..220
```

The resolver uses only new model-visible source for each next semantic call;
covered raw history is not summarized again.

## 7. Summary, security, authority, and raw-artifact evidence

- The summary request is one call with `tools=[]` and bounded target output.
- Non-STOP or malformed semantic output is not accepted as authority.
- Provider failure produces deterministic fallback; typed infrastructure failure
  and abort propagate without fallback or commit.
- The summary source serializer applies explicit trust framing, credential
  redaction, bounded safe semantic content, and deterministic serialization.
- Semantic claims are enriched with fresh deterministic durable facts; facts
  and persisted checkpoint truth outrank semantic claims.
- Raw Tool artifacts are read/reprojected only on the forced recovery
  materialization path. They are absent from semantic source, semantic draft,
  Coordinator input, facts semantic fields, and digest content.

## 8. Rebuild and token truth

The accepted chain is:

```text
planner retainedTokens = candidate plan estimate
materialized tentative estimate = projection.audit.report.estimatedInputTokens
durable tokensAfter = the same materialized estimate
```

The Phase 8D fixture asserts that the persisted value equals the final
materialized report, is not zero, and is not the retained planner estimate.
The candidate is rejected before commit if the shared production build remains
over the effective limit.

## 9. Persistence and recovery

Persistence evidence covers validation-before-write, rollback of checkpoint and
event sequence, cross-run event rejection, exact idempotent replay, immutable
conflict rejection, missing/duplicate completion proof rejection, and restart
replay without a second completion event.

Recovery evidence covers:

```text
NORMAL   → no action or one COMPACT_HISTORY action
FORCED   → DEFER_LOW_RETRIEVABLE
           REDUCE_OPTIONAL_SOURCES
           COMPACT_HISTORY
           TIGHTEN_RECENT_TAIL
           EXHAUSTED
```

Protected atomic groups remain selected. Optional low-retrievable groups may
be deferred; other optional groups may be dropped; required/current/open/pinned
groups are not silently removed.

## 10. Auxiliary budget and provider overflow

Budget evidence proves:

```text
kind                         = CONTEXT_COMPACTION
admission before provider    = PASS
settlement                   = actual usage
missing/failure usage        = conservative close
denied provider calls        = 0
Steps delta                  = 0
Tools delta                  = 0
```

The owner identity is deterministic and terminal/conservative owners are not
reopened.

Provider overflow evidence proves:

```text
main call #1 → CONTEXT_OVERFLOW
             → one FORCED_RECOVERY prepare
             → main call #2
main call #2 → CONTEXT_EXHAUSTED
main call #3 = 0
```

Production E2E coverage separately exercises normal daemon Context usage
persistence and forced recovery with a durable raw Tool artifact, bounded
reprojection, stable Tool call identity, and a successful recovered main
request. Main calls and auxiliary summary calls are asserted through their
separate fixtures rather than conflated into one gateway-call count.

## 11. Targeted acceptance

Final targeted matrix:

```text
test files = 32
tests      = 180 passed
failed     = 0
skipped    = 0
```

It includes every Phase 8A–8E Agent context test, the new Phase 8F final
architecture guard, Phase 8A/8B/8D architecture guards, Phase 2C public-surface
guard, AgentLoop advance/overflow, coding facts, Storage checkpoint/commit/
budget/usage tests, daemon summary/budget tests, and both Context production
E2E files.

## 12. Full `pnpm test` and failure classification

The final full-suite rerun was executed after the two stale acceptance
expectations were corrected:

```text
469 test files passed
3 tests skipped
1 test failed
3438 tests passed
3442 tests total
```

The single failure is:

```text
PRE_EXISTING_UNRELATED
apps/daemon/test/tool-prompt-production-e2e.test.ts
  Phase 4E prompt production E2E
  delivers the guidance block exactly once, inside the system context
  expected <tool_guidance>, but the produced system context had no guidance block
```

Reason for classification: the failing behavior belongs to the unrelated Phase
4E Tool prompt production path. It does not touch `packages/agent/src/context`,
Context Compaction, the Coordinator, Recovery, checkpoint persistence, budget
accounting, AgentLoop overflow, or any file modified by Phase 8F. The two
initially failing Context-related expectations were corrected and are green in
the final 32-file targeted matrix.

Therefore:

```text
REPOSITORY-WIDE FULL SUITE:
NOT GREEN — one unrelated Phase 4E tool-prompt E2E failure remains
```

This report does not reuse the historical Phase 8D probe (`3397/3/19`) as a
Phase 8F result.

## 13. Static gates and format debt

The required final static gates are run after the final source/test changes:

```text
pnpm build
pnpm typecheck
pnpm lint
pnpm check:architecture:ci
node scripts/check-repository-hygiene.mjs
targeted Prettier checks for all changed files
git diff --check
```

Acceptance requires architecture `new violations = 0`, `stale baseline entries
= 0`, and readiness `READY`. Existing repository-wide format debt is not part
of Phase 8F; it is not hidden, not modified, and `pnpm check` is intentionally
not used because it reruns full tests and global format debt.

## 14. Commits and final handoff

Phase 8F implementation commits:

```text
6d9506d
refactor(context): retire Phase 8E summary compatibility

b55f729
test(context): align phase guards with final compaction architecture

b2f23e3
test(context): refresh Phase 8F acceptance fixtures
```

The final acceptance document is committed separately after all evidence and
static gates are green. The exact final repository SHA is obtained from
`git rev-parse HEAD` after that commit and is reported as
`CONTEXT_COMPACTION_V2_FINAL_SHA` in the final handoff; no placeholder SHA is
used in the handoff.

## 15. Final scope statement

All Context Compaction V2 Phase 8F-relevant targeted tests pass, all frozen
Context Compaction invariants pass, the production authority is unique, the
transition-only summary compatibility is retired, and no Phase 8 blocker
remains. The repository-wide suite remains explicitly not green only because
of the unrelated Phase 4E tool-prompt E2E failure listed above.

No Phase 8G has started.
