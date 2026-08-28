import * as context from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("@caelush/context public API", () => {
  it("exports the application-facing inspector and approved value classes", () => {
    expect(context.ProjectInspector).toBeDefined();
    expect(context.createLocalProjectInspector).toBeDefined();
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
    expect(context.ContextIgnoreError).toBeDefined();
    expect(context.ContextDiscoveryError).toBeDefined();
    expect(context.IgnorePolicy).toBeDefined();
    expect(context.CandidateFileDiscovery).toBeDefined();
    expect(context.RelevantPathRanker).toBeDefined();
    expect(context.Utf8HeuristicTokenEstimator).toBeDefined();
    expect(context.FileBudgetSelector).toBeDefined();
    expect(context.RelevantFilePlanner).toBeDefined();
    expect(context.createLocalRelevantFilePlanner).toBeDefined();
    expect(context.ContextBuilder).toBeDefined();
    expect(context.createDefaultContextBuilder).toBeDefined();
    expect(context.ContextBuildError).toBeDefined();
    expect(context.ContextBudgetExceededError).toBeDefined();
    expect(context.ContextConversationError).toBeDefined();
    expect(context.ConversationTurnGroup).toBeUndefined();
    expect(context.renderSystemContext).toBeUndefined();
  });
});
