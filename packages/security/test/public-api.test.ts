import * as security from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("security public API", () => {
  it("exports the policy kernel without runtime or storage internals", () => {
    expect(security.resolveGrantedCapabilities).toBeTypeOf("function");
    expect(security.classifyExecutionContainment).toBeTypeOf("function");
    expect(security.evaluateSecurityPolicy).toBeTypeOf("function");
    expect(security.securityPolicyEvaluator).toMatchObject({ evaluate: expect.any(Function) });
    expect(security.CaelushToolExecutionGate).toBeTypeOf("function");
    expect(security.SecurityPolicyInputError).toBeTypeOf("function");
    expect(security.SecurityPolicyInvariantError).toBeTypeOf("function");
  });
});
