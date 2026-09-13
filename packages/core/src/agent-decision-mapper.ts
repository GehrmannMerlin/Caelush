/**
 * The legacy Core decision-classification facade.
 *
 * The classifier itself moved to `@caelush/agent` in Phase 3A, together with the
 * `AgentModelOutputError` it throws — that error stays exported from `agent-errors.js` so
 * there is exactly one object identity for it. This module re-exports the classifier so
 * existing Core call sites keep their import path, and it deliberately contains no logic:
 * a second classification implementation here would be a second decision authority, which
 * is exactly what the freeze forbids.
 */
export { classifyAgentDecision, createAgentDecisionClassifier } from "@caelush/agent";
