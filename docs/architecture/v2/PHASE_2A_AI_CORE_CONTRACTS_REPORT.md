# Caelush Architecture V2 — Phase 2A: AI Core Contracts & Gateway Foundation

Phase 2A is the first real subsystem migration after the Phase 1 guardrails. It
corresponds to **Compatibility Stage A** of the frozen AI Model Invocation V2
design:

```text
packages/ai    = V2 AI Core canonical implementation
packages/llm   = legacy runtime, unchanged and still operational
```

The `@caelush/llm → @caelush/ai` compatibility shim is **not** part of this round.
It belongs to Phase 2B. No file under `packages/llm/src/**` was modified.

---

## 1. What the AI core now owns

`@caelush/ai` is a complete, independently runnable and independently testable AI
Model Invocation core:

```text
ids/          ApiId, ProviderId, AI-local LLMCallId (llm_<UUIDv7>)
json/         JsonPrimitive, JsonValue, JsonObject
messages/     AI system / user / assistant / tool-result messages
tools/        AIToolSpec, AIToolCall, AIFinishReason
models/       ModelRef, limits, capabilities, reasoning and cache profiles,
              descriptor, descriptor sources, immutable ModelCatalog
providers/    credentials, binding, secret-safe descriptor, immutable registry,
              ResolvedProviderConnection
adapters/     ApiAdapter, AIAdapterEvent, immutable ApiAdapterRegistry
request/      AIToolChoice, AIModelSettings, AIModelRequest, resolved request,
              semantic validator
reasoning/    ReasoningLevel, reasoning resolution and resolver
cache/        CacheRetention, cache resolution and resolver
errors/       AIErrorCode, AIError, AISerializableError, sanitizer
stream/       public AIStreamEvent union, StreamValidator, AbortScope,
              TurnAssembler, AIStream
gateway/      frozen preflight resolver, AIGateway
```

`createAISubsystem()` wires all of it and validates the composition at startup.

---

## 2. Protocol independence

Phase 1C froze `@caelush/ai → none`: the AI core may not depend on any
`@caelush/*` workspace package, and specifically not on `@caelush/protocol`.

The earlier AI interface freeze used `@caelush/protocol` types in several
TypeScript examples. Phase 2A keeps every frozen **field, name, semantic,
behaviour and invariant**, and moves only **type ownership**:

| Frozen name  | Phase 2A owner | Note                                                  |
| ------------ | -------------- | ----------------------------------------------------- |
| `ModelRef`   | `@caelush/ai`  | same shape; `baseUrl` still legacy-only, not identity |
| `LLMCallId`  | `@caelush/ai`  | same `llm_<UUIDv7>` format, AI-domain identity        |
| `JsonObject` | `@caelush/ai`  | minimal, business-free JSON value model               |

Protocol keeps its existing `ModelRef`, `LLMCallId` and `JsonObject` as the wire
and durable contracts. Phase 2C introduces the explicit projection at the
Daemon / Protocol boundary. Phase 2A changes no Protocol id and no Protocol file.

Verification: `packages/ai/test/architecture-isolation.test.ts` parses every
module specifier in `packages/ai/src/**`, `packages/ai/test/**` and
`packages/ai/dist/**/*.d.ts` and requires zero `@caelush/*` specifiers, zero
provider SDK specifiers, and no `@caelush/*` entry in any dependency field of
`packages/ai/package.json`. The only third-party dependency is `uuid@14.0.2`,
reusing the version already pinned by `@caelush/protocol`.

---

## 3. The separation the core exists to express

```text
Model      != Provider      != API dialect
```

- A **model** is described by exactly one `ModelDescriptor`, which owns the API
  dialect, token limits, capability matrix, reasoning levels and cache support.
- A **provider** is a configured connection (`AIProviderBinding`): endpoint,
  credentials, allowlist, headers. It never describes a model.
- An **API dialect** is an `ApiId` served by exactly one `ApiAdapter`. Several
  providers may share one dialect and therefore one adapter instance.

`packages/ai/test/independent-use.test.ts` proves this with two providers, two
endpoints, two credential sets, one shared adapter and one gateway.

---

## 4. Model resolution precedence

`ModelCatalog.resolve()` consults **every** registered source and selects by:

```text
1. ModelDescriptor.source rank   CONFIGURATION → BUILTIN → PROVIDER_DEFAULT
                                 → DISCOVERED → FALLBACK
2. source priority               lower wins (tie-break inside one source kind)
3. registration order            final deterministic tie-break
```

Precedence is driven by the descriptor's own frozen `source` field rather than by
host-assigned priorities, so a host cannot accidentally invert the frozen order.

Descriptor sources are pure lookup tables: no network, no mutable environment
reads, no randomness. Every resolved descriptor is validated and snapshotted into
a deeply frozen copy, so a source cannot mutate what the catalog reports.

### Unknown models

A model that no source can describe fails as `AI_MODEL_METADATA_INCOMPLETE`. The
core never guesses a context window. A `FALLBACK` descriptor is only obtainable
from a host-provided safe-defaults source, and the gateway accepts it only when
the provider sets `allowUnknownModels: true`:

```text
fallback source exists            provider.allowUnknownModels === true
        ↓                                        ↓
        └──────────── FALLBACK descriptor accepted ───────────┘
                       otherwise AI_MODEL_METADATA_INCOMPLETE
```

`allowedModels`, when present, is authoritative and produces
`AI_MODEL_UNSUPPORTED` for anything not listed.

### Enumeration

`ModelCatalog.list()` and the subsystem startup integrity checks need the known
set, and the frozen `ModelDescriptorSourcePort` has no enumeration member. Rather
than widen the frozen port, enumeration is an **additive** capability:
`EnumerableModelDescriptorSourcePort extends ModelDescriptorSourcePort` with
`list()`. A resolve-only source — including every fallback source — keeps working
unchanged and simply contributes nothing to `list()`.

---

## 5. Gateway authority

The gateway is the only producer of `stream.start`, `stream.finish` and
`stream.error`. This is enforced by the type system, not only by convention:
`AIAdapterEvent` has no envelope variants at all.

```text
success           stream.start → 0..N events → stream.finish
runtime failure   stream.start → 0..N events → stream.error
preflight failure throw AIError — no stream is ever created
```

Preflight follows the frozen 17-step order exactly, and is implemented in
`gateway/gateway-request-resolver.ts`. Every rejection before step 17 throws.
Credential resolution is the only asynchronous step before the stream exists and
happens before any adapter is invoked, which is what makes "preflight failures
touch no provider I/O" structural rather than aspirational.

The gateway deliberately does **not**:

```text
retry                 one gateway invocation invokes adapter.stream exactly once
fail over             a provider or model failure is reported, never redirected
compact               AI_CONTEXT_OVERFLOW is reported, never repaired
execute tools         tool calls are data returned to the caller
```

`complete()` consumes the same public `AIStream` through the same
`AIModelTurnAssembler` as any other consumer. There is no second aggregation path.

### Abort, timeout and cancellation

`AbortScope` carries three distinct internal causes — `external`, `timeout`,
`consumer` — and the first cause wins. The scope owns its own signal; the
caller's signal is observed, never forwarded. A consumer that stops reading
aborts the consumer scope and closes the adapter iterator, and receives no
synthesised `stream.error`.

An abort cause takes precedence over the adapter's own error when normalising a
runtime failure: a cancelled or timed-out request reports that, not whatever
symptom the transport produced while unwinding.

---

## 6. Errors and secret safety

`AIErrorCode` is the closed 14-code set. `AIError.retryable` is derived from a
frozen per-code table, never supplied by a caller, so retryability cannot drift
per call site. Only `AI_RATE_LIMIT`, `AI_NETWORK` and `AI_TIMEOUT` are retryable.

`AISerializableError` is the only error shape allowed to cross the boundary. It
carries six frozen fields and never a cause, a stack, headers, credentials, a raw
request or a raw provider body. `assertAISerializableError` rejects unknown
fields, because an unknown field is exactly how one of those would travel.

`createAIErrorSanitizer()` removes credential material that appears in a
credential position, carries a recognisable provider token shape, or was declared
as a known secret. This is high-confidence redaction, not complete DLP coverage.

---

## 7. Phase 1 guardrail advance: the skeleton surface restriction

Phase 1C's readiness gate required all three Phase 1A skeletons (`ai`, `agent`,
`coding-agent`) to keep their public surface at `"."`, with the stated rationale
"before any code migrated". Phase 2A **is** that migration: the AI core now has a
real implementation, exports and tests.

The gate therefore advances for `ai` and only for `ai`:

```js
V2_SKELETON_PACKAGES = ["ai", "agent", "coding-agent"]; // unchanged
V2_MIGRATED_SKELETON_PACKAGES = ["ai"]; // Phase 2A
V2_SURFACE_LOCKED_SKELETON_PACKAGES = ["agent", "coding-agent"]; // derived
```

- `agent` and `coding-agent` still may not publish any subpath.
- `ai` may publish exactly the surface it earned; the exact list is asserted in
  `tests/architecture/architecture-v2-migration-boundaries.test.ts`, so the
  surface cannot widen by accident.
- The **dependency-free guarantee is unchanged and applies to every skeleton**:
  `ai` may publish surfaces but may never declare a legacy dependency.

Nothing in the dependency freeze moved. `V2_ALLOWED_DEPENDENCIES.ai` is still
`[]`, the rule set is still version 2 with 276 rules, the baseline is still 33
entries, and `new violations: 0` / `stale baseline entries: 0` still hold.

---

## 8. Public surface

```text
@caelush/ai              composition entry point and every contract
@caelush/ai/messages     message and tool-spec contract
@caelush/ai/models       model descriptor, sources, catalog
@caelush/ai/request      request contract and validator
@caelush/ai/stream       public stream contract, validator, assembler, abort scope
@caelush/ai/errors       error codes, AIError, sanitizer
@caelush/ai/providers    provider binding and registry
@caelush/ai/adapters     adapter contract and registry
```

`reasoning` and `cache` are deliberately reachable from the root only. Phase 2A
has no external consumer for them, and widening a public surface ahead of a real
consumer is what the migration execution contract forbids.

---

## 9. Handover to Phase 2B

Phase 2B migrates the OpenAI-compatible runtime into this core and turns
`@caelush/llm` into a `legacy → target` facade. Open questions Phase 2A leaves
explicitly open:

- **Real adapters.** `adapters/openai-compatible/**` and
  `adapters/anthropic-messages/**` do not exist. Provider SDKs are banned from
  the package in 2A; after 2B the rule narrows to "SDKs only under
  `adapters/**`".
- **Wire diagnostic.** `packages/llm/src/wire-diagnostic.ts` is untouched and
  undecided: 2B chooses whether it becomes an AI Core diagnostic or stays a
  legacy shim diagnostic.
- **Sanitizer wiring.** `createAIErrorSanitizer({ knownSecrets })` exists and
  works, but nothing yet feeds the credentials resolved during preflight into it.
  2B is the natural place to close that loop.
- **Consumer boundary.** Nothing consumes `@caelush/ai` yet. The projection from
  Protocol `ModelRef` / `LLMCallId` / `ToolDefinition` onto the AI types belongs
  to the Agent / CodingAgent / Daemon boundary in 2C.
