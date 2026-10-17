import { SessionIdSchema, WorkspaceIdSchema } from "@caelush/protocol";

export function parseWorkbenchDeepLink(search: string): {
  readonly initialWorkspaceId?: ReturnType<typeof WorkspaceIdSchema.parse>;
  readonly initialSessionId?: ReturnType<typeof SessionIdSchema.parse>;
  readonly initialSettingsOpen: boolean;
} {
  const query = new URLSearchParams(search);
  const workspace = WorkspaceIdSchema.safeParse(query.get("workspace"));
  const session = SessionIdSchema.safeParse(query.get("session"));
  return {
    ...(workspace.success ? { initialWorkspaceId: workspace.data } : {}),
    ...(session.success ? { initialSessionId: session.data } : {}),
    initialSettingsOpen: query.get("settings") === "models",
  };
}
