# Verification Completion Authority

Phase 11D is the final Phase 11 round. There is no 11E or Phase 12. The Core
`RunController` is the only Completion Authority. `VerificationRunner`, the
Task reviewer, `AgentLoop`, LLM providers, Tools, and Runtime may produce facts
or evidence, but none of them owns completion.

A passing verification evaluation is necessary but not sufficient. Before
completion Core re-reads the durable boundary, verifies the candidate hash,
rechecks workspace bytes and Git state, computes the evidence digest, and
creates a deterministic Completion Seal. The seal is an integrity digest, not
a cryptographic signature.

Workspace freshness uses the existing `WorkspacePathResolver` and Runtime
filesystem. Each declared changed path is represented by a bounded raw-byte
fingerprint containing kind, size, and SHA-256. Hashing is streaming; text
normalization, BOM removal, and newline conversion are never used. Missing,
symlink, directory, outside, incomplete, or truncated observations are not
silently treated as fresh. Git freshness reuses Runtime Git status and diff
data, comparing unmerged paths, attribution, per-path diff hashes, truncation,
and review completeness. Untracked bytes are covered by the workspace hash.

`VerifiedRunFinalResult` contains only the completion type, exact candidate
text, plan/source/candidate/evidence/freshness/seal hashes, and bounded check
counts. It contains no stdout, stderr, diffs, raw evidence, prompts, hidden
reasoning, credentials, or host paths. `COMPLETED` requires this result,
`finishedAt`, a passed AgentState, no current Step, and no continuation.

Run, State, final result, continuation clear, and completion events settle in
one SQLite transaction. The durable order is:

```text
verification.finalized → status.changed(VERIFYING→COMPLETED) → run.completed
```

The transaction guards status, continuation identity, source Step, exact plan,
expected revisions, and cancellation intent. Cancellation, deadline, budget,
or a competing terminal commit wins. Events are published only after commit.
