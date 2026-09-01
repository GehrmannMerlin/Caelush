# CLI Session Resume and Active Run Recovery

Phase 12D makes Session selection and restart recovery explicit while keeping
Session and Run ownership in the daemon. The CLI never creates a replacement
Session merely because it cannot prove that an old Session belongs to the
current workspace.

## Launch intents

The pure bootstrap parser accepts exactly one of:

```text
caelush                 → NEW
caelush --continue      → CONTINUE
caelush -c              → CONTINUE
caelush --resume        → RESUME_PICKER
caelush -r              → RESUME_PICKER
caelush --resume ID     → RESUME_EXACT
```

Conflicting, unknown, missing, malformed, repeated or extra arguments are
safe argument errors and exit with code 1 before React or a Session is
created. `--continue` and `--resume` never create a new Session as a fallback.

## Workspace matching and candidate order

`--continue` lists at most 100 Sessions and enriches candidates with at most
one newest Run each, with a maximum concurrency of eight. Candidate activity
is derived from `finishedAt ?? startedAt ?? createdAt ?? session.updatedAt`,
not from `session.updatedAt` alone. The controller normalizes paths before
matching the current workspace, sorts activity descending and breaks ties by
Session ID ascending. No matching Session is a safe error.

The picker shows only current-workspace candidates, at most 100 rows, with a
title, short ID and last-activity time. Up/Down changes a bounded selection;
Enter selects and Esc exits. No Run or Session is created before selection.

An exact resume loads the requested Session and reuses its complete
`defaultWorkspace` (`id` and normalized `path`) when present. A path mismatch
is an error and the CLI never changes directory. Legacy Sessions without a
default workspace are accepted only when all visible Runs have exactly one
identical workspace reference. Zero Runs or conflicting/missing workspace
evidence is ambiguous and fails closed; the CLI never guesses from the current
directory or creates a new workspace ID.

## History hydration and new Runs

The controller lists at most 100 Runs for the selected Session. Since the API
is newest-first, the public transcript is rebuilt in `createdAt ASC`, then Run
ID `ASC` order. Each historical goal becomes one user entry. Only a valid
`VerifiedRunFinalResult.text` from a completed Run becomes an assistant entry.
Failed, cancelled, timeout, max-step and budget terminal Runs become bounded
terminal notices. Invalid final results become safe notices. Raw Tool,
Provider, Continuation, patch, command, reasoning and evidence payloads never
enter the hydrated transcript.

The selected active goal is added once. A newly submitted resumed Run uses the
Session model when present, otherwise the daemon default model, and always
uses the current daemon `defaultRunConfiguration`; historical permissions or
runtime settings are not copied into a new Run.

## Non-terminal Run policy

Visible non-terminal Runs are limited to `PENDING`, `RUNNING`,
`WAITING_APPROVAL` and `VERIFYING`. There is no composer while recovery is
undecided. With one candidate the CLI attaches to it; with multiple candidates
it presents a Run Recovery Picker and never guesses. A `PENDING` Run requires
an explicit start confirmation. `RUNNING` and `VERIFYING` attach the event
stream and admit at most one `recoverRun()` call per stream generation;
`ALREADY_ACTIVE` is normal, while `SCHEDULED` means the daemon accepted the
recovery after restart. `WAITING_APPROVAL` lists pending approvals first and
recovers only when none remain.

Recovery consumes the same durable event projection as a cold Run. It creates
`createInitialCliTimelineState(run.id)`, watches with `afterSequence: 0`, and
then reuses the existing timeline reducer. It does not introduce a second
reducer or replay raw durable history into the public transcript.

`Ctrl+D` during recovery detaches only the local host. The daemon Run remains
recoverable by a later exact resume or picker selection. Phase 12D does not
add daemon auto-start, fork/rename operations, background Session mutation,
non-interactive mode, or Phase 12E packaging behavior.
