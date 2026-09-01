export { resolveGrantedCapabilities } from "./capabilities.js";
export { classifyExecutionContainment, requiresUnconfinedProcess } from "./containment.js";
export type { ExecutionContainment } from "./containment.js";
export { evaluateLogicalSandboxAdmission } from "./logical-sandbox.js";
export type { LogicalSandboxAdmission, LogicalSandboxAdmissionInput } from "./logical-sandbox.js";
export { evaluateSecurityPolicy, securityPolicyEvaluator } from "./evaluator.js";
export { combineSecurityDecisions } from "./decision.js";
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
export {
  detectSecrets,
  redactJson,
  redactToolArgumentsForPresentation,
  redactText,
  secretDetector,
  secretRedactor,
  MAX_SECRET_JSON_DEPTH,
  MAX_SECRET_JSON_NODES,
  MAX_SECRET_SCAN_TEXT_BYTES,
} from "./secret-redaction.js";
export { CaelushToolResultSanitizer, sanitizeToolResult } from "./tool-result-sanitizer.js";
export {
  CaelushToolPresentation,
  type CaelushToolPresentationOptions,
  type TerminalOutputSanitizer,
} from "./presentation.js";
export {
  assertDefaultBuiltinSecurityCoverage,
  createDefaultV1ToolExecutionSecurity,
  createV1SecureToolDispatcher,
  V1SecurityCompositionError,
} from "./default-composition.js";
export type {
  V1SecureToolDispatcherOptions,
  V1ToolExecutionSecurity,
} from "./default-composition.js";
export type {
  SecretCategory,
  SecretDetectionReport,
  SecretDetector,
  SecretRedactor,
} from "./secret-redaction.js";
export type {
  CommandClassification,
  CommandPlatform,
  CommandPolicyAnalysis,
  CommandPolicyInput,
} from "./command-policy.js";
export {
  assessVerificationCommand,
  verificationEvidenceSanitizer,
  verificationCommandSecurityPort,
} from "./verification-admission.js";
export type {
  VerificationCommandSecurityAssessmentInput,
  VerificationCommandSecurityInput,
  VerificationCommandSecurityPort,
  VerificationSecurityDecision,
} from "./verification-admission.js";
