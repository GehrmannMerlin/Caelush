# Session Conversation Lifecycle

Phase 12B makes `AgentSession` the durable conversation identity and `AgentRun`
the durable unit of one prompt/lifecycle. A CLI process uses one Session and one
Run per prompt. Runs remain independently persisted; old Run messages are never
copied into a new Run's `agent_messages` ledger.

## Derived verified history

The daemon's `SessionConversationContextProvider` reads only
`RunRepository.listBySession()` and returns a data-only
`RunExecutionConfig.historyPrefix`. It does not read Conversation, Tool,
Observation, Runtime, event, or provider storage. The current Run's `createdAt`
is the immutable boundary.

A prior Run is eligible only when all rules hold:

- the Session ID, workspace ID, and workspace path exactly match;
- status is `COMPLETED`;
- `finishedAt` exists and `finishedAt <= currentRun.createdAt`;
- `finalResult` passes `VerifiedRunFinalResultSchema`.

Candidates are ordered by `createdAt ASC`, then Run ID `ASC`. The newest bounded
suffix is at most `MAX_SESSION_HISTORY_RUNS = 100`, and each eligible Run projects
to exactly two provider-neutral messages:

```text
priorRun.goal            → { role: "user", content: goal }
verifiedFinalResult.text → { role: "assistant", content: [{ type: "text", text }] }
```

Failed, cancelled, timed-out, max-step, budget-exceeded, unfinished, invalid,
different-Session, different-workspace, and late-finished Runs are excluded.
Tool calls/results, stdout/stderr, patches, file details, reasoning summaries,
provider request data, credentials, and host paths are never projected.

The provider bounds Runs, not tokens. `ContextBuilder` remains the sole token
authority and applies its existing conversation budget to the prefix as ordinary
prior history. No second estimator or silent message truncation exists.

## Current Run and retry boundaries

Core receives the optional prefix through `RunExecutionConfig.historyPrefix?`.
`RunController` prepends it to fresh `AgentLoop.run()` input after removing the
current Run's persisted open turn. `AgentLoop.run()` then adds the current goal
once. For `resumeWithToolResults()`, Core prepends the prefix to the complete
current open turn, preserving the assistant Tool-call and normalized Tool-result
messages exactly once.

The same resolver runs on start, retry, recovery, and verification repair. The
provider recomputes history using the same current Run creation timestamp, so a
concurrent later completion cannot appear in a retry. The prefix is synthetic
model input only: it is never included in `messagesToAppend`, Conversation
Storage, continuation checkpoints, events, or public Run results.

## Public daemon defaults

`DaemonInfo.defaultRunConfiguration` is strict JSON-safe public data:

```json
{
  "runtime": { "id": "local", "kind": "local" },
  "permissionProfile": "PROJECT_ACCESS",
  "approvalPolicy": "DANGEROUS_ONLY",
  "limits": { "maxSteps": 8, "maxToolCalls": 8, "timeoutMs": 10000 }
}
```

It contains no endpoint, credential, database path, or machine identity. The CLI
uses this value verbatim. `defaultModel` remains optional; the CLI treats a
missing model or default Run configuration as a bootstrap configuration error
and creates no Session.

## Invariants

One Session can contain many Runs, but a Run has one goal and one lifecycle.
Durable conversation remains scoped to that Run. Completion is still owned by
Core/RunController after Verification and Completion Authority; history selection
accepts only an already valid verified result and cannot authorize completion.
