export { resolveGrantedCapabilities } from "./capabilities.js";
export { classifyExecutionContainment, requiresUnconfinedProcess } from "./containment.js";
export type { ExecutionContainment } from "./containment.js";
export { evaluateSecurityPolicy, securityPolicyEvaluator } from "./evaluator.js";
export type {
  SecurityDecision,
  SecurityDecisionCode,
  SecurityPolicyEvaluator,
  SecurityPolicyInput,
} from "./decision.js";
export { SecurityPolicyInputError, SecurityPolicyInvariantError } from "./errors.js";
export { CaelushToolExecutionGate } from "./tool-gate.js";
export type { SecurityToolDefinition } from "./tool-gate.js";
