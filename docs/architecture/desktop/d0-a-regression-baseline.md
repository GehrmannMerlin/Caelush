# D0-A Regression Baseline

- **Round:** Caelush Desktop & Cloud — D0-A
- **Base SHA:** `0ad8ebf48e31c59567dfc8fc25f7c76c78811685`
- **Branch at audit:** `main`
- **Current repository/workspace version at Base SHA:** `0.1.0`
- **Protocol:** Daemon API `v1`, Protocol version `1`
- **Test environment:** Node.js `v24.18.0`, pnpm `11.21.0`, dependencies already present
- **Baseline date:** 2026-10-09

This document records observed code and tests at the D0-A source baseline. It
does not define a performance SLA or assert that scripted fixture usage equals a
real provider's Prompt Cache behavior.

## 1. Agent authority baseline

The source audit confirms the execution boundary remains in the shared Daemon
composition. The following responsibilities must not be recreated in Electron
Main or Renderer.

| Capability                                                  | Current authority                                                           | Desktop constraint                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| AgentLoop and durable conversation contracts                | `@caelush/agent`                                                            | Desktop invokes existing Daemon routes; it does not construct an AgentLoop or format provider-native history |
| Run lifecycle and Completion Authority                      | `@caelush/core` / `RunController`                                           | Desktop never starts, recovers, or completes a Run using its own state machine                               |
| Tool registry, batch coordination, and Dispatcher lifecycle | `@caelush/agent` and `@caelush/coding-agent` through the Daemon composition | Desktop does not register a second Tool catalog or execute a Tool directly                                   |
| Local filesystem, process, shell, and PTY substrate         | `@caelush/runtime`                                                          | Desktop must call the Daemon API; it does not import Runtime or create another process-execution authority   |
| SQLite repositories and migrations                          | `@caelush/storage`                                                          | Desktop does not open the Agent SQLite database or add a parallel persistence model                          |
| Durable RunEvents                                           | Storage-backed Run/Tool authority transactions                              | Desktop does not append or synthesize durable events                                                         |
| Event observation, bounded queues, and replay/live bridge   | Daemon `RunEventHub` and public projection                                  | Desktop consumes the existing SSE stream through the shared client/proxy                                     |
| Model-turn gateway and Provider adapters                    | `@caelush/ai`, composed by Daemon                                           | Desktop does not host inference or Provider SDK execution                                                    |
| Context, Prompt Surface, and prompt-cache-related state     | Existing Agent/Daemon/Storage paths                                         | Cloud identity and Desktop UI state must not be added as prompt input                                        |

The Daemon remains the only production composition root. `apps/daemon/src/daemon.ts`
opens Storage, constructs the Runtime, calls `composeDaemon`, builds the Fastify
app, and owns shutdown. `apps/daemon/src/daemon-composition.ts` supplies the
shared execution graph. The desktop process may supervise that Daemon, but may
not duplicate any row above.

## 2. Representative Coding Run

### Selected tests

1. `apps/daemon/test/daemon-production-e2e.test.ts` —
   `executes tools, natural completion, and durable SSE replay through the client`.
2. `apps/daemon/test/representative-coding-cache-gate.test.ts` —
   `runs a Vue/Vite workspace through Tool replay, verification and terminal Usage`.

Both use test-owned workspaces and fixture providers. No paid model or real
DeepSeek/OpenAI endpoint is used.

### Observed path and assertions

The production Daemon E2E starts a Daemon on an OS-assigned loopback port, reads
`/api/v1/info`, creates a Session and Run through `@caelush/client`, subscribes
to the Run SSE stream, then starts the Run through the existing API. The Start
response remains `PENDING`/`SCHEDULED` while execution is in flight. A fixture
provider produces model turns and Tool calls; the existing Tool path reads and
patches a test workspace. The Run reaches `COMPLETED` with a
`NORMAL_COMPLETION`, one final assistant record, and the test's production
verification path satisfied.

The same E2E observes `run.started`, model/Tool events, `run.completed`, and the
completion ordering: final assistant commit, then `COMPLETED` status, then
`run.completed`. It replays after a middle durable sequence and asserts the
replayed durable sequence list matches the original suffix without gaps or
duplicates. It closes/reopens Storage and a new Daemon, then confirms the Run's
final result and projected Tool observation data remain readable. The test
therefore exercises create, start, model turn, Tool execution, lifecycle,
durable observation, replay, persistence, and final-result read through the
existing public client boundary.

The representative cache-gate test exercises the production composition and
RunController against a local scripted provider. Its patch Tool changes a
temporary Vue/Vite workspace; the production Build verification passes, the
Run reaches `COMPLETED`, and the fixture records three model requests. It checks
Tool-call replay, verification status, and Prompt Cache accounting coverage.
The test-defined provider usage reports all three request records as complete
and `unchangedSectionReemissionCount` as `0`. These are assertions about the
offline fixture and prompt-surface accounting path, not observed DeepSeek cache
hit tokens or a live hit-rate measurement.

### Coverage boundary

These tests cover the local Daemon/Client/Storage path, not a future Electron
child-process handshake, Profile binding, Host Token, or Cloud login flow. Those
remain D0-C/D3/D4 work. Desktop must keep the same Run and Tool authorities when
those host features are added.

## 3. Web and CLI compatibility baseline

### Current connection path

- Web `createWebCaelushClient()` defaults its base URL to the current browser
  origin and constructs the shared `CaelushClient`.
- Web bootstrap requests Health before Info, validates the existing strict
  Protocol schemas, and moves to a protocol-incompatible state when the
  handshake does not match.
- CLI uses `CAELUSH_DAEMON_URL` or `http://127.0.0.1:43120`. Launcher
  `ensureDaemon()` probes Health and Info, validates `apiVersion: "v1"` and
  `protocolVersion: 1`, compares the local Launcher/Daemon version for a local
  Daemon, and can reuse or start the ordinary local Daemon.
- Session and Run operations use `/api/v1` Protocol DTOs through the shared
  client. Existing Transcript reads require `capabilities.sessionTranscript`;
  a missing required capability throws `CaelushProtocolCompatibilityError`.
- Desktop must not use the ordinary Launcher “reuse any compatible local
  Daemon” path as proof of authenticated Profile ownership.

### Selected compatibility tests

`apps/web/test/bootstrap.test.ts` and `apps/cli/test/bootstrap.test.ts` passed.
The Web tests cover Health-before-Info, unavailable Daemon handling, strict
protocol incompatibility, launch context validation, and shared-client
construction. The CLI tests cover configured/default loopback URL selection
and safe transport/protocol failure messages. These tests do not assert future
Desktop behavior.

## 4. SSE and durable-event baseline

### Current contract

- The route is `GET /api/v1/runs/{runId}/events`.
- The Daemon reads `Last-Event-ID` and `afterSequence`; malformed cursors or two
  conflicting cursor values are rejected with a typed cursor error.
- `RunEventHub.watch()` subscribes before reading the durable reader's fixed
  high-water mark. It validates strict sequence order, pages replay through that
  mark, deduplicates buffered durable events, discards catch-up transient
  output, then tails live events.
- Durable SSE `id` is the event's durable sequence. The Client rejects a
  missing/mismatched durable id and rejects an id on an ephemeral event.
- Web and CLI reconnect orchestration resumes from their last durable sequence
  using the existing `afterSequence` cursor. The Client passes `AbortSignal`
  into fetch and cancels the reader; the route aborts the Hub watch when the
  connection closes.
- Hub queues are bounded by count and UTF-8 bytes. Durable/ordered overflow
  closes the slow subscription; same-stream coalescible pending progress uses
  latest-wins. Observer workers isolate slow callbacks and callback failures.

### Selected tests

`apps/daemon/test/sse-reconnect.test.ts` and
`apps/daemon/test/run-event-hub.test.ts` passed. The tested cases include
`Last-Event-ID`, query cursor validation, replay without gaps/duplicates, fixed
high-water replay followed by live events, durable commit during replay,
transient catch-up discard, ahead-of-watermark rejection, cancellation, item
and byte bounds, slow subscriber isolation, and transient coalescing.

The production Daemon E2E in §2 additionally confirms durable sequence replay
through `CaelushClient` after a real local Run completes. No Event contract,
replay algorithm, queue policy, or SSE route was changed in D0-A.

## 5. DeepSeek Prompt Cache and Security Prompt baseline

### Security Prompt invariants observed

`RunSecurityPromptProjector` projects bounded synthetic context from the
semantic policy and current Runtime facts. The selected tests assert:

- Changing only the audited snapshot `createdAt` changes the storage digest but
  leaves model-visible text and its semantic fingerprint equal.
- Changes to permission profile, approval policy, filesystem/process boundary,
  enforcement requirements, policy versions, Runtime kind, sandbox provider,
  enforcement, or TTY support change the model-visible Security Prompt and its
  fingerprint.
- Reordering policy object fields does not change the projected prompt.
- The prompt does not print the full policy digest or host paths in the
  assertions exercised.

The equal/different fingerprint comparisons passed. The tests do not print a
fixed fingerprint value, and this report records no literal digest.

### Prompt Surface and accounting invariants observed

The selected Prompt Surface V3 test prepares a `BASELINE`, persists and
materializes it, then confirms the next equivalent preparation is a `NOOP` and
that the persisted projection can be read back. The representative offline
coding fixture reports three observed requests, three complete cache-usage
records, `REPORTED` coverage, and zero unchanged-section re-emission.

The fixture's cache-token numbers are scripted by the local test provider. No
live Provider Cache response was measured, so no cache hit percentage, token
count, cost saving, or universal SLA is inferred from these runs.

### Privacy and capability rules for Desktop

There is no Cloud identity integration in this source baseline, so Cloud
`user_id`, email, Device ID, and Offline Grant expiry are not current Agent
prompt inputs. Desktop window/panel state, Browser/Terminal panel toggles, and
update state are also not current inputs. The existing local workspace path is
part of normal workspace execution context; the future Profile identity/root
must not be injected as extra account metadata. Future Desktop-only/account
metadata must stay outside the Prompt Surface when it does not change execution
capability. Real permission and Runtime capability changes must continue to
change their corresponding Security Prompt facts. Cache stability may not
remove Security Prompt content, skip Tool Guard, reuse a prompt across
different capabilities, or rewrite a Provider request to falsify usage.

### Coverage gaps

- Offline tests cannot establish a real DeepSeek cache hit rate or provider
  retention behavior. Live Provider validation is outside D0-A and requires a
  separately authorized milestone.
- There is no source test varying hypothetical Cloud account/device metadata,
  Desktop UI state, or update state because those inputs do not exist in the
  current product code. Their exclusion is frozen as a future boundary here.
- A hash comparison was asserted by existing tests, but no literal prompt hash
  was emitted or captured as a golden number.
- The Desktop AST boundary checker examines supported source files under
  `apps/desktop/src` and Caelush dependencies declared in
  `apps/desktop/package.json`. It recognizes literal static imports, exports,
  dynamic imports, and `require` forms handled by the TypeScript parser. It
  does not resolve tsconfig/bundler path aliases, computed module specifiers,
  symlink escapes, generated output, or code outside `src`; D3 must keep source
  layout and aliases within this checked boundary or add equivalent tested
  resolution before introducing them.

## 6. Test and gate results

All entries below are actual commands executed from the audited checkout.

| Check                                        | Command or selected case                                                                                                                                             | Result                                                                                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New Desktop boundary                         | `pnpm exec vitest run tests/architecture/desktop-boundaries.test.ts`                                                                                                 | PASS — 6 tests                                                                                                                                                                                                                                           |
| Architecture CI                              | `pnpm check:architecture:ci`                                                                                                                                         | PASS — V2 rule set 2, 276 existing rules; 17 workspace projects; 820 existing source files / 4,555 module specifiers; 14 frozen legacy findings, 0 new/stale; migration readiness READY. Desktop production source files: 0; fixture tests are non-empty |
| Web/CLI                                      | `pnpm exec vitest run apps/web/test/bootstrap.test.ts apps/cli/test/bootstrap.test.ts`                                                                               | PASS — 11 tests                                                                                                                                                                                                                                          |
| SSE/RunEventHub                              | `pnpm exec vitest run apps/daemon/test/sse-reconnect.test.ts apps/daemon/test/run-event-hub.test.ts`                                                                 | PASS — 20 tests                                                                                                                                                                                                                                          |
| Prompt Surface/Security Prompt               | Targeted three-case selection from `security-prompt-projector.test.ts` and `prompt-surface-v3-production.test.ts` (test-name expression below)                       | PASS — 3 selected tests; unrelated tests skipped by name filter                                                                                                                                                                                          |
| Representative offline Coding Run/cache gate | `pnpm exec vitest run apps/daemon/test/representative-coding-cache-gate.test.ts -t "runs a Vue/Vite workspace through Tool replay, verification and terminal Usage"` | PASS — 1 selected test; 7 unrelated tests skipped by name filter                                                                                                                                                                                         |
| End-to-end Daemon/Client Run and durable SSE | `pnpm exec vitest run apps/daemon/test/daemon-production-e2e.test.ts -t "executes tools, natural completion, and durable SSE replay through the client"`             | PASS — 1 selected test; 1 unrelated test skipped by name filter                                                                                                                                                                                          |
| Formatting                                   | Targeted Prettier check of changed Markdown, checker, and architecture tests                                                                                         | PASS after formatting                                                                                                                                                                                                                                    |
| Whitespace                                   | `git diff --check`                                                                                                                                                   | PASS at final review                                                                                                                                                                                                                                     |
| Repository hygiene (supplemental)            | `node scripts/check-repository-hygiene.mjs`                                                                                                                          | FAIL — flags the pre-existing tracked `docs/plans/provider-stream-recovery/`; this path is outside D0-A edit scope and was left unchanged                                                                                                                |

The Prompt Surface/Security Prompt regression used:

```text
pnpm exec vitest run apps/daemon/test/security-prompt-projector.test.ts apps/daemon/test/prompt-surface-v3-production.test.ts -t "keeps the model prompt stable|changes the semantic prompt|prepares, durably stores and materializes one BASELINE followed by a NOOP"
```

The repository hygiene finding is present in tracked files at the audited Base
SHA and is not part of the D0-A change.

Full monorepo tests, build, lint, Windows sandbox/installer, browser E2E, and
live Provider tests were not run. D0-A changes only architecture tooling/tests
and documentation; those larger checks are outside the requested minimum
validation scope.
