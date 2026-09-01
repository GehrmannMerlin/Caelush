# CLI Presentation Security

Phase 12C introduces a safe presentation boundary for user-visible Tool
activity. Presentation is a UI projection, not permission authority, execution
authority, or a replacement for the existing Security policy kernel.

```text
ToolInvocation / sanitized ToolExecutionResult
                    │
                    ▼
       ToolPresentationPort (packages/tools)
                    │
                    ▼
       CaelushToolPresentation (packages/security)
                    │
                    ├── safe title/summary
                    ├── bounded safe result preview
                    └── safe shell command label
```

`packages/tools` defines the provider-independent, data-only port. It does not
depend on `@caelush/security`. The default daemon composition creates the
Security implementation and injects it into `ToolDispatcher`. A presentation
exception is caught and omitted or replaced with a generic label; Tool handler
execution, durable `REQUESTED`/`RUNNING`/terminal settlement, Observation and
approval behavior continue unaffected.

The Daemon Composition Root also passes the existing Runtime terminal sanitizer
as a pure function dependency. Security therefore reuses the Runtime policy
without importing `@caelush/runtime`, preserving the package boundary and
keeping presentation failure non-fatal.

## Public event fields

Existing optional `AgentEvent` base fields `title` and `summary` are reused.
Tool lifecycle event payloads still contain identity and risk metadata, never
`ToolInvocation.args`. The optional settlement `tool.output` event contains
only a bounded presentation stream/chunk. It is emitted after the result has
passed the existing result sanitizer and before the terminal Tool event is
committed. There is no raw-output event channel and no new Protocol version.

The nine built-in labels are:

| Tool             | User-facing label     |
| ---------------- | --------------------- |
| `read_file`      | Read file             |
| `list_directory` | List directory        |
| `find_files`     | Find files            |
| `search_text`    | Search text           |
| `apply_patch`    | Edit files            |
| `exec_command`   | Run command           |
| `write_stdin`    | Interact with process |
| `git_status`     | Check Git status      |
| `git_diff`       | Inspect Git diff      |

Unknown Tool names fall back to their bounded name and do not crash the
presenter. `apply_patch` shows only a change count/summary. `read_file` shows a
workspace-relative path and line count, not the entire file. `git_diff` consumes
the already sanitized Tool result and retains the existing sensitive-diff
redaction; Phase 12C does not invent a workspace-wide Agent diff.

## Secrets and sensitive paths

The Security presenter reuses the existing `redactText`, `redactJson`,
`redactToolArgumentsForPresentation`, `classifySensitivePath` and
`CaelushToolResultSanitizer`. It does not create another detector or CLI-only
secret regex. Sensitive workspace paths are shown as `[sensitive path]` in
presentation summaries. Tool results are sanitized before a preview is
created, and the preview is sanitized again for terminal controls and bounded
for display.

Command presentation follows this order:

```text
raw exec_command.cmd
  → existing Secret Redaction
  → existing Runtime terminal sanitizer
  → 4 KiB UTF-8 head/tail bound
  → USER_VISIBLE summary
```

The boundary covers API-key/secret assignments, Bearer and Basic
Authorization values, URL credentials, query tokens, provider tokens such as
`sk-…`, private-key blocks and password assignments. It never displays
`write_stdin.chars`, password input, stdin content, environment variables or
authorization credentials. If command safety cannot be established, the
display is simply `Run command`.

Terminal output removes OSC title/hyperlink sequences, CSI cursor/control
sequences, other escape sequences and unsafe C0 controls while retaining
newline, tab and normal Unicode. The CLI renderer applies a second terminal
control sanitizer and UTF-8 byte bound to event-derived text as defense in
depth. This protects the user's terminal; it is not a substitute for the
Phase 9 secret redaction policy.

## Visibility and privacy

Only `USER_VISIBLE` AgentEvents are projected into the normal timeline.
`DEBUG` and `SYSTEM` are ignored. Raw provider payloads, hidden chain of
thought, system prompts, raw Tool arguments, raw patches, credentials,
Observation internals, evidence details, seal hashes and exception text do not
enter public timeline entries. Reasoning is limited to the explicit
`reasoning.summary` event. Safe error entries use only bounded public code and
phase information.

The Security presentation boundary does not change the model-facing
`ToolExecutionResult`, durable Observation or Tool execution semantics. A
display failure cannot authorize, deny, retry, cancel or rerun a Tool.
