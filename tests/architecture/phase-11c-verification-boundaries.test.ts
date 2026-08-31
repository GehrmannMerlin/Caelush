import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

function sourceTree(directory: string): string {
  return readFileSync(path.join(root, directory), "utf8");
}

describe("Phase 11C architecture boundaries", () => {
  it("keeps Verification provider/runtime/storage free and completion-free", () => {
    const verification =
      sourceTree("packages/verification/src/index.ts") +
      sourceTree("packages/verification/src/task-review.ts") +
      sourceTree("packages/verification/src/change-runner.ts") +
      sourceTree("packages/verification/src/workspace-verifier.ts") +
      sourceTree("packages/verification/src/git-verifier.ts") +
      sourceTree("packages/verification/src/repair.ts");
    expect(verification).not.toMatch(/@caelush\/(runtime|storage|tools|llm)/);
    expect(verification).not.toMatch(/node:(fs|child_process)/);
    expect(verification).not.toContain("COMPLETED");
  });

  it("keeps Runtime below Verification and reviewers tool-free", () => {
    const runtime =
      sourceTree("packages/runtime/src/index.ts") +
      sourceTree("packages/runtime/src/git/service.ts");
    expect(runtime).not.toMatch(/@caelush\/verification/);
    const reviewer = sourceTree("packages/core/src/task-acceptance-reviewer.ts");
    expect(reviewer).toContain('toolChoice: { type: "NONE"');
    expect(reviewer).not.toContain("ToolInvocation");
  });

  it("keeps repair as a continuation rather than a new RunStatus", () => {
    const continuation = sourceTree("packages/core/src/agent-continuation.ts");
    expect(continuation).toContain('"WAITING_VERIFICATION_REPAIR"');
    const statuses = sourceTree("packages/protocol/src/run.ts");
    expect(statuses).not.toContain("WAITING_VERIFICATION_REPAIR");
  });
});
