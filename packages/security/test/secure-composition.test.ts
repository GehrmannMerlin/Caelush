import { describe, expect, it } from "vitest";
import {
  V1SecurityCompositionError,
  assertDefaultBuiltinSecurityCoverage,
  createDefaultV1ToolExecutionSecurity,
} from "../src/index.js";
import {
  createDefaultBuiltinToolRegistrations,
  ToolRegistryBuilder,
  type ToolRegistry,
} from "@caelush/tools";

const identityTerminalSanitizer = (value: string): string => value;

describe("default V1 security composition", () => {
  it("returns the real gate and sanitizer", () => {
    const security = createDefaultV1ToolExecutionSecurity({
      terminalOutputSanitizer: identityTerminalSanitizer,
    });
    expect(security.gate.constructor.name).toBe("CaelushToolExecutionGate");
    expect(security.presentation.constructor.name).toBe("CaelushToolPresentation");
    expect(security.resultSanitizer.constructor.name).toBe("CaelushToolResultSanitizer");
  });

  it("rejects a registry without complete default builtin facts coverage", () => {
    const incomplete = {
      resolve: () => undefined,
    } as unknown as ToolRegistry;
    expect(() => assertDefaultBuiltinSecurityCoverage(incomplete)).toThrow(
      V1SecurityCompositionError,
    );
    expect(() => assertDefaultBuiltinSecurityCoverage(incomplete)).toThrow("read_file");
  });

  it("audits the actual default builtin catalog successfully", () => {
    const builder = new ToolRegistryBuilder();
    for (const registration of createDefaultBuiltinToolRegistrations({
      resolve: () => undefined,
    })) {
      builder.register(registration);
    }
    expect(() => assertDefaultBuiltinSecurityCoverage(builder.build())).not.toThrow();
  });
});
