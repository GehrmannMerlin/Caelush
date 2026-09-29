import type { AgentSession } from "@caelush/protocol";
import type { RunRepository, SessionRepository } from "@caelush/storage";
import { canonicalizeWorkspacePath } from "./workspace-identity.js";
import type { WorkspaceService } from "./workspace-service.js";

export interface WorkspaceBackfillSummary {
  readonly bound: number;
  readonly unbound: number;
  readonly ambiguous: number;
}

export interface WorkspaceBackfillOptions {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly workspaceService: WorkspaceService;
}

export async function backfillSessionWorkspaceOwnership(
  options: WorkspaceBackfillOptions,
): Promise<WorkspaceBackfillSummary> {
  let bound = 0;
  let unbound = 0;
  let ambiguous = 0;

  for (const session of await options.sessions.list()) {
    if (session.workspaceId !== undefined) {
      bound += 1;
      continue;
    }

    const candidate = await findWorkspaceCandidate(session, options);
    if (candidate.kind === "AMBIGUOUS") {
      ambiguous += 1;
      continue;
    }
    if (candidate.kind === "UNBOUND") {
      unbound += 1;
      continue;
    }

    const registration = await options.workspaceService.registerWorkspace({ path: candidate.path });
    await options.sessions.update({
      ...session,
      workspaceId: registration.workspace.id,
      defaultWorkspace: options.workspaceService.toWorkspaceRef(registration.workspace),
    });
    bound += 1;
  }

  return { bound, unbound, ambiguous };
}

type WorkspaceCandidate =
  | { readonly kind: "BOUND"; readonly path: string }
  | { readonly kind: "UNBOUND" }
  | { readonly kind: "AMBIGUOUS" };

async function findWorkspaceCandidate(
  session: AgentSession,
  options: WorkspaceBackfillOptions,
): Promise<WorkspaceCandidate> {
  if (session.defaultWorkspace !== undefined) {
    return candidateFromPath(session.defaultWorkspace.path);
  }

  const runs = await options.runs.listBySession(session.id);
  if (runs.length === 0) return { kind: "UNBOUND" };

  const paths = new Set<string>();
  for (const run of runs) {
    try {
      paths.add(canonicalizeWorkspacePath(run.workspace.path));
    } catch {
      return paths.size > 0 ? { kind: "AMBIGUOUS" } : { kind: "UNBOUND" };
    }
  }
  if (paths.size === 0) return { kind: "UNBOUND" };
  if (paths.size > 1) return { kind: "AMBIGUOUS" };
  return { kind: "BOUND", path: [...paths][0]! };
}

function candidateFromPath(path: string): WorkspaceCandidate {
  try {
    return { kind: "BOUND", path: canonicalizeWorkspacePath(path) };
  } catch {
    return { kind: "UNBOUND" };
  }
}
