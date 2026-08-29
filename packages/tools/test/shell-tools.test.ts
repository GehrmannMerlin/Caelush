import { describe, expect, it } from "vitest";
import { createShellToolRegistrations } from "../src/index.js";
import type { RuntimeResolver } from "@caelush/runtime";

describe("shell Tool registrations", () => {
  it("registers exec_command and write_stdin against one supplied resolver", () => {
    const resolver = { resolve: () => undefined } satisfies RuntimeResolver;
    const registrations = createShellToolRegistrations(resolver);
    expect(registrations.map(({ definition }) => definition.name)).toEqual([
      "exec_command",
      "write_stdin",
    ]);
    expect(registrations[0]!.definition.requiredCapabilities).toEqual([
      "SHELL_EXEC",
      "PROCESS_START",
    ]);
    expect(registrations[1]!.definition.requiredCapabilities).toEqual([
      "SHELL_EXEC",
      "PROCESS_START",
      "PROCESS_KILL",
    ]);
  });
});
