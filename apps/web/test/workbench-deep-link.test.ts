import { describe, expect, it } from "vitest";
import { createSessionId, createWorkspaceId } from "@caelush/protocol";
import { parseWorkbenchDeepLink } from "../src/host/workbench-deep-link.js";

describe("Workbench deep links", () => {
  it("accepts session, workspace, and model-settings destinations", () => {
    const sessionId = createSessionId();
    const workspaceId = createWorkspaceId();

    expect(
      parseWorkbenchDeepLink(
        `?session=${encodeURIComponent(sessionId)}&workspace=${encodeURIComponent(workspaceId)}&settings=models`,
      ),
    ).toEqual({
      initialSessionId: sessionId,
      initialWorkspaceId: workspaceId,
      initialSettingsOpen: true,
    });
  });

  it("ignores invalid identifiers and unsupported settings values", () => {
    expect(parseWorkbenchDeepLink("?session=bad&workspace=bad&settings=passwords")).toEqual({
      initialSettingsOpen: false,
    });
  });
});
