# Tool Effects and State Projection

A successful, output-validated built-in result may be projected into a small host-side `ToolEffect` union. Projectors are pure and deterministic: they do not access Runtime, Storage, EventBus, LLMs, or the filesystem. Error results, uncertain execution, and projector failures produce no effects.

The current effects are `FILE_READ`, `FILE_CHANGE`, `SHELL_STARTED`, `SHELL_COMPLETED`, `PROCESS_STARTED`, and `PROCESS_STOPPED`. A file read emits a durable `file.read` event but does not change the state projection. `apply_patch` maps its validated change summaries to created, modified, deleted, or moved effects. Successful shell execution emits a shell-start effect; a running process additionally emits process-start, while a completed command emits shell-completed. A completed `write_stdin` emits process-stopped. List, find, search, and Git inspection are state-neutral.

The pure AgentState reducer keeps the latest file summary per path, removes both ends of a move before inserting its target summary, moves updated entries to the end, and retains at most 500 entries. Active processes are keyed by the opaque session ID and contain the fixed public label `shell command`; raw commands and stdin remain only in private ToolInvocation data.

Tool settlement applies state effects, writes the new snapshot revision, appends effect events, and appends the terminal Tool event in one `BEGIN IMMEDIATE` transaction. Commit happens before notification. If the transaction fails after the Runtime side effect, the Invocation remains in its prior running state and existing recovery classifies it as uncertain; no handler is replayed automatically.
