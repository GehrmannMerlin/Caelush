# Runtime execution

The Runtime owns local process and workspace operations. Verification commands use the typed
`executeArgv()` adapter, which applies workspace containment, bounded output, cancellation, and
process-session ownership before returning evidence to the Verification boundary.
