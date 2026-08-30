# Secret Redaction

Phase 9C provides deterministic, high-confidence redaction. It is not a complete DLP system and does not encrypt Tool arguments at rest.

```text
RAW PRIVATE DATA
      |
      v
Security Boundary
      |
      +--> Redacted Approval Preview
      +--> Redacted ToolObservation
      +--> Safe Events
      +--> Safe Logs / model-facing content
```

## Detector and redactor

The detector covers private-key blocks, Authorization Bearer/Basic bodies, URL userinfo, credential query parameters, provider-shaped tokens, and contextual secret assignments such as `api_key`, `token`, `password`, `credential`, and `private_key`. It intentionally does not use entropy alone. Explicit placeholders (`YOUR_API_KEY`, `<token>`, `${TOKEN}`, `REDACTED`, `changeme`, `example`, `placeholder`, and `xxxx`) are not treated as live values unless a stronger provider-shaped pattern matches.

Text redaction is deterministic and idempotent. Full secret values are replaced with `[REDACTED]`; no prefix, suffix, hash, fingerprint, match offset, or raw secret enters the report. Text over 64 KiB and JSON work beyond depth 8 or 1000 nodes use `[REDACTED:SCAN_LIMIT]` rather than returning an unscanned tail.

`redactJson` preserves numbers, booleans, and null, recursively scans strings/arrays/objects, and replaces values under clearly sensitive keys. `redactToolArgumentsForPresentation` is a presentation helper only; the durable private `ToolInvocation.args` is never rewritten.

## Result pipeline

The injected `ToolResultSanitizerPort` is implemented by `@caelush/security`. The Dispatcher pipeline is:

```text
handler -> raw result in memory -> raw validation -> sanitize
        -> sanitized validation -> effects -> observation/events -> storage
```

The sanitized result is what effects and durable observations receive. If sanitization or sanitized revalidation fails after a handler has run, the Dispatcher leaves the durable invocation `RUNNING`; recovery produces the existing uncertain-side-effect boundary and does not replay the handler automatically.

Sensitive file contents, search matches, diffs, shell output, stdin output, and error details all pass through the general boundary. Metadata-only results retain structural metadata while never treating filenames alone as content reads.

## Privacy and storage boundary

Approval actions are generated from facts and redacted before persistence. Tool and approval event payloads remain structural-safe. Raw command, stdin, patch, and file content are excluded from events, observations, model-facing result messages, and public errors.

`ToolInvocation.args` remains private durable execution data because recovery, idempotency, exact execution, and exact approval identity depend on it. Phase 9C does not encrypt those arguments at rest; Caelush must not claim that secrets never exist in SQLite.
