export type ManagedProcessState = "STARTING" | "RUNNING" | "EXITED" | "FAILED";

export function isManagedProcessTerminal(state: ManagedProcessState): boolean {
  return state === "EXITED" || state === "FAILED";
}
