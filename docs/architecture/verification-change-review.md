# Phase 11C Change Review

Phase 11C evaluates Agent-attributed changes after a Final Candidate. The immutable plan is executed in ordinal order: existing `PROJECT` checks, `WORKSPACE` changeset sanity, `GIT` changeset review, and finally `TASK` acceptance. A check is durably marked `RUNNING` before its injected filesystem, Git, or reviewer capability is used; terminal evidence is stored with the check and its committed lifecycle event.

Workspace review is metadata-only. It checks the durable `changedFiles` attribution ledger for regular-file existence, deletion, symlink, boundary, and inspection-completeness facts through the existing Runtime workspace scope. It is not exhaustive filesystem history and does not claim Shell side effects as Agent-authored without durable attribution.

Git review delegates to the existing read-only `RuntimeGitService` through a host-composed structural port. It never stages, restores, resets, checks out, stashes, commits, invokes a Git Tool, or creates a second Git implementation. Status and diff data are bounded, sorted, hashed per path, and marked incomplete when truncation prevents a reliable decision. Dirty paths outside the attribution set are warnings; unmerged state fails closed.

All evidence is JSON-safe and bounded. It contains summaries and safe metadata rather than credentials, Runtime objects, database rows, raw hidden reasoning, or unbounded command/diff output. A passing change review does not complete a Run; completion remains outside Phase 11C.
