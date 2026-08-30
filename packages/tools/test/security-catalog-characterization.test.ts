import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import { createDefaultBuiltinToolRegistrations } from "../src/index.js";

describe("Phase 8D security metadata", () => {
  it("characterizes the real default built-in catalog", () => {
    const registrations = createDefaultBuiltinToolRegistrations(
      createLocalRuntimeResolver(new LocalRuntime()),
    );
    const metadata = Object.fromEntries(
      registrations.map(({ definition }) => [
        definition.name,
        {
          riskLevel: definition.riskLevel,
          requiredCapabilities: definition.requiredCapabilities,
        },
      ]),
    );

    expect(metadata).toEqual({
      read_file: { riskLevel: "LOW", requiredCapabilities: ["FS_READ"] },
      list_directory: { riskLevel: "LOW", requiredCapabilities: ["FS_READ"] },
      find_files: { riskLevel: "LOW", requiredCapabilities: ["FS_READ"] },
      search_text: { riskLevel: "LOW", requiredCapabilities: ["FS_READ"] },
      apply_patch: { riskLevel: "HIGH", requiredCapabilities: ["FS_WRITE", "FS_DELETE"] },
      exec_command: {
        riskLevel: "CRITICAL",
        requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
      },
      write_stdin: {
        riskLevel: "CRITICAL",
        requiredCapabilities: ["SHELL_EXEC", "PROCESS_START", "PROCESS_KILL"],
      },
      git_status: { riskLevel: "LOW", requiredCapabilities: ["GIT_READ"] },
      git_diff: { riskLevel: "LOW", requiredCapabilities: ["GIT_READ"] },
    });
  });
});
