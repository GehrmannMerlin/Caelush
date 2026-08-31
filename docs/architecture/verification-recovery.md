# Verification Recovery and Late Results

Recovery inspects the existing durable boundary. It does not replan, resend a
provider turn, rerun a Tool, or replay a verification check merely because the
process restarted.

Recovery precedence is terminal Run, cancellation, deadline, budget,
continuation identity, stale verification execution, existing evaluation,
safe pending checks, repair handoff, then completion or failure. An expired Run
performs zero Provider, Tool, Runtime, or reviewer calls.

A durable `RUNNING` PROJECT, WORKSPACE, GIT, or TASK check is an uncertain
execution boundary. Recovery settles it once as `ERROR` with bounded
`VERIFICATION_INTERRUPTED` evidence and never reruns the command, inspection,
or reviewer. A safe `PENDING` check may continue in ordinal order. Reviewer
in-flight usage is recovered conservatively through the existing budget ledger.

Blocking `ERROR` results and repair exhaustion settle the Run as `FAILED` with
`VERIFICATION_FAILED`. A blocking `FAILED` result can use the existing bounded
repair continuation while capacity remains. A passing result is rechecked for
freshness immediately before the atomic completion commit.

Verification and completion writes guard the Run boundary. Writes received
after `COMPLETED`, `FAILED`, `CANCELLED`, `TIMEOUT`, `MAX_STEPS_REACHED`, or
`BUDGET_EXCEEDED` are rejected as conflicts. Stale source Step, plan,
continuation, revision, and candidate identity are also rejected. Accepted
results are never redispatched after restart, and late results cannot reopen a
terminal Run.
