import type { AgentState, Observation, ToolInvocation } from "@caelush/protocol";
import type { DeterministicCompactionFacts } from "@caelush/agent";

const MAX_READ_FILES = 256;
const MAX_CHANGED_FILES = 500;
const MAX_RECENT_ERRORS = 64;
const MAX_ACTIVE_PROCESSES = 64;
const SAFE_PROCESS_LABEL = "shell command";

export type CodingCompactionFacts = Pick<
  DeterministicCompactionFacts,
  "readFiles" | "changedFiles" | "recentErrors" | "activeProcesses"
>;

export function projectCodingCompactionFacts(input: {
  readonly invocations: readonly ToolInvocation[];
  readonly observations: readonly Observation[];
  readonly state: AgentState | null;
}): CodingCompactionFacts {
  const observationsByInvocation = new Map(
    input.observations
      .filter(
        (observation): observation is Extract<Observation, { kind: "TOOL" }> =>
          observation.kind === "TOOL",
      )
      .map((observation) => [String(observation.toolInvocationId), observation]),
  );
  const readFiles = dedupe(
    input.invocations
      .filter(
        (invocation) => invocation.toolName === "read_file" && invocation.status === "COMPLETED",
      )
      .map((invocation) => {
        const observation = observationsByInvocation.get(String(invocation.id));
        if (observation === undefined || observation.isError) return undefined;
        const path = observation.details?.path;
        return typeof path === "string" && path.length > 0 ? path : undefined;
      })
      .filter((path): path is string => path !== undefined),
  ).slice(0, MAX_READ_FILES);
  const changedFiles = dedupe((input.state?.changedFiles ?? []).map((file) => file.path)).slice(
    -MAX_CHANGED_FILES,
  );
  const recentErrors = (input.state?.errors ?? [])
    .map((error) => `${error.phase ?? "UNKNOWN"}:${error.code}:${safeText(error.message)}`)
    .slice(-MAX_RECENT_ERRORS);
  const activeProcesses = (input.state?.activeProcesses ?? [])
    .map((process) => `${process.id}:${process.status}:${SAFE_PROCESS_LABEL}`)
    .slice(0, MAX_ACTIVE_PROCESSES);
  return Object.freeze({
    readFiles: Object.freeze(readFiles),
    changedFiles: Object.freeze(changedFiles),
    recentErrors: Object.freeze(recentErrors),
    activeProcesses: Object.freeze(activeProcesses),
  });
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safeText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\bdetails?\s*[:=]\s*\S+/gi, "details=[REDACTED]")
    .slice(0, 512);
}
