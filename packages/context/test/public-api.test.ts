import * as context from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("@caelush/context public API", () => {
  it("exports the application-facing inspector and approved value classes", () => {
    expect(context.ProjectInspector).toBeDefined();
    expect(context.createLocalProjectInspector).toBeDefined();
    expect(context.LocalContextFileSystem).toBeDefined();
    expect(context.WorkspaceScopeResolver).toBeDefined();
    expect(context.ProjectRootDetector).toBeDefined();
    expect(context.ProjectProfileDetector).toBeDefined();
    expect(context.ProjectInstructionDiscovery).toBeDefined();
    expect(context.LocalEnvironmentDetector).toBeDefined();
    expect(context.ContextError).toBeDefined();
    expect(context.ContextInvalidWorkspaceError).toBeDefined();
    expect(context.ContextBoundaryError).toBeDefined();
    expect(context.ContextInstructionError).toBeDefined();
    expect(context.ContextIOError).toBeDefined();
  });
});
