# Implementation Plan: Context Runtime Correctness Repair

Branch: `codex/v1-context-runtime-correctness-repair`
Baseline: `3be40eaf6d012216b30b29cfc38b43b8be5d7762`

1. Characterize the real coordinator/AgentLoop continuation failure and record root-cause evidence.
   Keep the characterization RED until the corresponding repair exists.
2. Repair model profile authority and daemon configuration: strict per-model profile parsing,
   explicit/known/legacy/fallback precedence, production injection, and safe diagnostics.
3. Correct budget arithmetic so policy effective input is not safety-subtracted twice; add exact
   16K/32K/128K and zero/non-zero reserve tests.
4. Make observation projection policy-aware at single and batch levels, including deterministic
   tightening levels and open-turn reprojection while preserving tool protocol cardinality.
5. Compose real ExecutionUnits, ContextPressureController, and ContextRehydrator in the coordinator;
   compact only closed units, preserve recent tail/open unit, and persist real before/after estimates.
6. Integrate proactive/emergency pressure decisions and one-shot provider context-overflow recovery
   into the real AgentLoop with rebuilt requests and no duplicated tool effects.
7. Add durable context runtime state and restart-safe usage API; remove the daemon 32K recovery
   constant and update the existing Web ring/inspector fields without layout changes.
8. Add deterministic production-composition scenarios A–K, run targeted suites, launch an independent
   read-only `gpt-5.6-luna` reviewer, apply no more than three corrective review cycles, then run
   full/release verification and push only the task branch.

Each implementation change follows TDD: focused failing test, minimal repair, focused pass,
integration pass, and full regression. `master` is not merged or pushed in this task.
