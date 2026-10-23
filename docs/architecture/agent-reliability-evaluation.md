# Agent reliability evaluation

This document describes the three _separate_ layers that answer "can the Agent finish a long task?".
They never substitute for one another, and no layer may be reported as if it were a different one.

| Layer                     | Entry point                                         | What it can prove                                                                                 | What it cannot prove                                                   |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Engineering regression    | `pnpm test`, the `reliability` CI job               | The production chain accepts, rejects, recovers and records correctly                             | That a model chooses the right action                                  |
| Feedback-driven behaviour | `apps/daemon/test/reliability-feedback-e2e.test.ts` | A scripted model drives the real daemon through correction, repair, compaction and failed history | Anything about a real model's judgement                                |
| Real-model evaluation     | `pnpm test:reliability:real` (explicit only)        | One model, one configuration, one scenario, observed on disk                                      | A general success rate, a different provider, or a different workspace |

The scripted scenarios in `apps/daemon/test/support/feedback-driven-adapter.ts` and the 250-step
long-run test only exercise _capacity_: they show the infrastructure keeps ordered results, budgets
and checkpoints under load. They are named `INFRASTRUCTURE_CAPACITY` in their own metrics for that
reason. `scripts/long-run-reliability-offline.mjs` prints `REAL_MODEL_ADAPTATION  NOT MEASURED` on
every run.

## Real-model evaluation

`scripts/reliability-real-model-eval.mjs` is a headless client of an **already running** loopback
Daemon. It uses only `@caelush/client`; it does not build an Agent, a Provider or a Tool executor, so
it cannot pass by bypassing the product. Credentials stay in the Daemon: nothing secret is accepted
on argv and every reported string is redacted and bounded.

```bash
node scripts/reliability-real-model-eval.mjs \
  --base-url http://127.0.0.1:43120 \
  --provider <configured-provider-id> \
  --model <configured-model-id> \
  --workspace-root <new directory outside the repository> \
  --output-dir <directory outside the repository> \
  --scenario all
```

`--scenario all` runs the five small scenarios. `--scenario low-code-platform` additionally requires
`--requirement-file`, because the original user requirement is not duplicated in this repository.

### Scenario contract

A scenario in `scripts/reliability-eval-scenarios.mjs` owns its seed files, its prompt, its Run list
and its checks. A check may only return `PASS` after observing a fact outside the model's prose:

- a file on disk (`exists`, `hash`, `json`),
- a subprocess exit code (`node <script>`),
- a Daemon projection (`compactionCount`, terminal Run status).

Checks never read the assistant text. A scenario that deliberately contains an unsuccessful
historical Run declares `toleratedRunStatuses` for that Run name; nothing else can excuse a
non-successful Run.

### Verdicts

`PASS` / `FAIL` / `BLOCKED` / `NOT_RUN` are computed by `resolveScenarioVerdict`:

1. an explicit block (unreachable Daemon, missing provider credential, unavailable model, unresolved
   approval) wins — nothing ran, so nothing passed;
2. a failed check fails the scenario, even when the Run reports `COMPLETED`;
3. an exhausted budget (`MAX_STEPS_REACHED`, `BUDGET_EXCEEDED`, `TIMEOUT`) fails the scenario;
4. any other non-successful Run fails the scenario;
5. a check that could not be concluded blocks it;
6. `PASS` requires every check to pass _and_ every Run to reach `COMPLETED`.

`COMPLETED` is never functional acceptance. The low-code-platform scenario reports its interactive
items (`editor-drag-drop`, `property-panel`, `undo-redo`, `schema-save-load`, `live-preview`,
`publish`, `reload-persistence`) as `BLOCKED` unless a browser driver, a real preview/publish
endpoint or a real MySQL/Redis instance is supplied — file-only development mode is never reported as
a complete requirement.

### Report

One JSON report plus one text summary are written to `--output-dir` (outside the repository):

```text
reliability-eval-<timestamp>.json   schemaVersion 1: status, source HEAD, model, limits, runs,
                                    checks, usage, unmet items
reliability-eval-<timestamp>.txt    the same verdicts in one screen
```

The report is scoped: paths collapse to a workspace-relative form, anything outside the allowed roots
becomes `<external>/<basename>`, credentials are redacted, and every detail is bounded to 2 000
characters. A single `PASS` covers only that model, that configuration and that scenario.

## Fixtures are tested without a model

`scripts/reliability-real-model-eval.test.mjs` runs the runner against a fake client: budget
exhaustion, a missing model, an unresolved approval, a dispatch failure, a `COMPLETED` Run without an
artifact, and redaction/scoping all have to produce a non-`PASS` verdict.

`scripts/reliability-eval-scenarios.test.mjs` executes each scenario's _real_ checks against a
simulated workspace: every check must fail before the accepted artifact exists and pass afterwards,
otherwise the check is decoration rather than evidence.
