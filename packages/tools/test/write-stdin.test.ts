import { describe, expect, it } from "vitest";
import { createWriteStdinRegistration } from "../src/index.js";
import type { RuntimeResolver } from "@caelush/runtime";

describe("write_stdin Tool", () => {
  it("uses empty chars as a poll and declares conservative capabilities", () => {
    const resolver = { resolve: () => undefined } satisfies RuntimeResolver;
    const registration = createWriteStdinRegistration(resolver);
    expect(registration.definition.inputSchema).toMatchObject({
      required: ["session_id"],
      additionalProperties: false,
    });
    expect(registration.definition.requiredCapabilities).toEqual([
      "SHELL_EXEC",
      "PROCESS_START",
      "PROCESS_KILL",
    ]);
  });
});
