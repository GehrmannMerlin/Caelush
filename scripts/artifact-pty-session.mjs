// Four 5-second drains plus the initial 2-second execute stay inside the parent 30-second timeout.
const MAX_PTY_DRAIN_POLLS = 4;

export async function collectPtyResult(exec, request) {
  let result = await exec.execute(request);
  let output = result.output;
  let polls = 0;
  while (result.status === "RUNNING" && polls < MAX_PTY_DRAIN_POLLS) {
    if (result.sessionId === undefined) throw new Error("The PTY session has no session ID.");
    result = await exec.interact({
      ownerRunId: request.ownerRunId,
      sessionId: result.sessionId,
      chars: "",
      yieldTimeMs: 5000,
    });
    output += result.output;
    polls += 1;
  }
  return { ...result, output };
}
