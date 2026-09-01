# Shared Client Transport

`@caelush/client` is the Phase 12A transport foundation for CLI, Web, and future
hosts. It is deliberately smaller than an Agent client: it knows how to speak the
public Caelush HTTP/SSE contract, but it does not own Agent execution, policy,
recovery, rendering, or persistence.

## Package boundary

Production code in `packages/client/src` depends only on `@caelush/protocol` and
standard Web platform APIs (`fetch`, `Response`, `ReadableStream`, `TextDecoder`,
`AbortSignal`, `Headers`, and `URL`). It has no Node built-ins and no imports from
Core, Runtime, Storage, Security, Tools, Context, Verification, LLM, Fastify, or
EventBus. This makes the same package usable from a browser bundle and from a
Node-based host that supplies a compatible `fetch`.

The client does not create a provider registry, run loop, Tool dispatcher, approval
manager, or verification runner. It also does not use `EventSource`, because
explicit cursor control is part of the V1 transport contract.

## HTTP surface

`CaelushClient` exposes typed methods for:

- `getHealth()` and `getInfo()`;
- Session create/list/get;
- Run create/list/get;
- explicit `startRun()`, `recoverRun()`, and `cancelRun()` actions;
- pending Approval listing and `resolveApproval()`;
- `watchRunEvents()` for the durable/live event stream.

Each JSON request validates the caller input with its strict Protocol schema before
calling `fetch`. Each successful response is schema-validated before being returned.
The public model shape is only `{ provider, model }`; a client cannot send a
provider endpoint, credential, header, or arbitrary provider option through the
transport.

Non-2xx responses are parsed only as the bounded `ApiErrorResponse` envelope and
become `CaelushClientHttpError` with `status`, `code`, and optional `requestId`.
Malformed envelopes receive a generic internal error. Response bodies, provider
SDK text, credentials, prompts, tool arguments, and stack traces are not copied into
the public error message. An unsupported `/info` API/protocol version is reported as
`CaelushProtocolCompatibilityError` before an incompatible daemon is exposed to the
caller.

The client does not retry HTTP actions. In particular, it never repeats a start,
cancel, approval resolution, or provider operation based on a network timeout.
Callers decide whether to inspect the Run again or explicitly invoke recovery.
`AbortSignal` is forwarded to HTTP requests and cancels an active SSE reader; an
already-aborted caller retains the platform abort behavior rather than becoming a
hidden retry.

## SSE contract

`watchRunEvents(runId, { afterSequence })` uses the Web Streams API and an
incremental UTF-8 `TextDecoder`. The parser handles LF, CRLF, and CR delimiters,
delimiters split across chunks, split multibyte Chinese/emoji bytes, comments,
field ordering, multiline `data`, and multiple frames in one chunk. Frames and
HTTP error reads are bounded.

Every data frame is parsed as JSON and validated with `AgentEventSchema`. The
client additionally checks:

- the event `runId` is the requested Run;
- an SSE `event` field, when present, matches the Protocol event type;
- a durable event has a decimal safe-integer `id` equal to its
  `durability.sequence`;
- an ephemeral event has no SSE `id`.

Heartbeat comments are ignored. Ephemeral events do not move the durable cursor.
The last durable sequence is therefore available from the yielded event identity
(`event.durability.sequence`), and the caller can explicitly pass that sequence to
a new watch request after reconnecting. The client intentionally still has no
automatic reconnect policy, backoff, deduplication cache, or UI timeline. Phase
12D places the bounded reconnect policy in the CLI controller around this
transport; the shared client remains an explicit-cursor, provider-independent
HTTP/SSE adapter.

The daemon remains the authoritative source: its SSE implementation consumes
`EventBus.watch()`, uses exclusive durable replay, and joins replay to the live
tail. The client only validates the stream; it does not infer Run status from event
names or repair missing events.

## Lifecycle action semantics

HTTP action responses contain a public Run projection plus a transport disposition:
`SCHEDULED`, `ALREADY_ACTIVE`, `NOOP_TERMINAL`, or `SETTLED`. A `202` start,
recovery, or approval-resolution response means that Core work is accepted and is
being driven in the daemon process; it does not mean the Run is complete. Progress
and final authority are observed through `getRun()` and validated AgentEvent SSE.

Cancellation is a direct server action with Phase 10A priority. Approval resolution
is sent to the daemon and Core re-enters the existing durable Approval workflow; the
client never attempts to update an Approval or Tool state locally. A client may
query pending approvals, present them in a later host UI, and send a strict
`APPROVE`/`REJECT` resolution without gaining permission authority.

## Version and future reuse

`GET /api/v1/info` is the handshake. The client requires `apiVersion: "v1"`,
`protocolVersion: 1`, the advertised local runtime, and the allowlisted capability
shape defined by Protocol. It does not guess compatibility from an HTTP status or
ignore an unknown contract field.

Because the package stops at transport, future CLI/Web hosts can share it without
sharing a second AgentLoop. A later host may add presentation, polling policy,
resume UX, or a reconnect controller around this package, while Core and the daemon
remain the sole execution authorities.

## Phase 12A non-goals

No Ink or React rendering, keyboard handling, Ctrl+C UX, approval prompt, resume
picker, timeline/diff renderer, CLI packaging, Web UI, WebSocket, CORS, Web Search,
MCP, Browser, Computer Use, provider CRUD, auth, automatic reconnect, or client-side
policy override is part of `@caelush/client`.

## Phase 12B host consumption

Phase 12B consumes this existing typed transport from `apps/cli`; it adds no
second HTTP layer, direct daemon `fetch`, URL construction, or SSE parser in the
CLI. The CLI calls `getHealth()`/`getInfo()`, creates one Session, creates one Run
per prompt, watches the durable/live stream before starting the Run, and fetches
the canonical Run once after a terminal event. The controller owns only view state
and local stream disposal; the daemon remains the authority for status, verified
final results, and durable history.

The Phase 12B/12C CLI did not automatically reconnect, resume, cancel, or
resolve Approval. Phase 12D adds those policies in `apps/cli`, while this
package still only validates transport and forwards typed actions. A stream
failure remains a safe transport activity and the active Run lock remains in
place until the CLI controller explicitly recovers, cancels, detaches, or
observes canonical terminal state.
