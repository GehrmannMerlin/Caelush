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
export {
  classifySensitivePath,
  isValidWorkspaceFactPath,
  normalizeWorkspaceFactPath,
} from "./sensitive-path.js";
export type { SensitivePathCategory } from "./sensitive-path.js";
export { evaluateInputSecurityPolicy } from "./input-policy.js";
export type {
  InputSecurityAssessment,
  InputSecurityAssessmentKind,
  InputSecurityContext,
} from "./input-policy.js";
export {
  analyzeCommand,
  MAX_COMMAND_PREVIEW_BYTES,
  MAX_COMMAND_WRAPPER_DEPTH,
} from "./command-policy.js";
export type {
  CommandClassification,
  CommandPlatform,
  CommandPolicyAnalysis,
  CommandPolicyInput,
} from "./command-policy.js";
