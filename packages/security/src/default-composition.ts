import type { ToolDefinition } from "@caelush/protocol";
import {
  DEFAULT_BUILTIN_TOOL_ORDER,
  ToolDispatcher,
  type ToolApprovalRequestIdFactory,
  type ToolApprovalStorePort,
  type ToolClock,
  type ToolDispatcherOptions,
  type ToolEventIdFactory,
  type ToolInvocationIdFactory,
  type ToolObservationIdFactory,
  type ToolCommittedEventNotifier,
  type ToolExecutionGatePort,
  type ToolExecutionStorePort,
  type ToolRegistry,
  type ToolResultSanitizerPort,
  type ToolPresentationPort,
} from "@caelush/tools";
import { CaelushToolExecutionGate } from "./tool-gate.js";
import { CaelushToolPresentation, type TerminalOutputSanitizer } from "./presentation.js";
import { CaelushToolResultSanitizer } from "./tool-result-sanitizer.js";

export interface V1ToolExecutionSecurity {
  readonly gate: ToolExecutionGatePort;
  readonly resultSanitizer: ToolResultSanitizerPort;
  readonly presentation: ToolPresentationPort;
}

export class V1SecurityCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V1SecurityCompositionError";
  }
}

export function createDefaultV1ToolExecutionSecurity(options: {
  readonly terminalOutputSanitizer: TerminalOutputSanitizer;
}): V1ToolExecutionSecurity {
  return Object.freeze({
    gate: new CaelushToolExecutionGate(),
    presentation: new CaelushToolPresentation(options),
    resultSanitizer: new CaelushToolResultSanitizer(),
  });
}

export interface V1SecureToolDispatcherOptions extends Omit<
  ToolDispatcherOptions,
  "gate" | "resultSanitizer" | "presentation" | "approvalStore" | "approvalIdFactory"
> {
  readonly approvalStore: ToolApprovalStorePort;
  readonly approvalIdFactory: ToolApprovalRequestIdFactory;
  readonly terminalOutputSanitizer: TerminalOutputSanitizer;
}

export function createV1SecureToolDispatcher(
  options: V1SecureToolDispatcherOptions,
): ToolDispatcher {
  assertDefaultBuiltinSecurityCoverage(options.registry);
  const security = createDefaultV1ToolExecutionSecurity({
    terminalOutputSanitizer: options.terminalOutputSanitizer,
  });
  return new ToolDispatcher({
    ...options,
    gate: security.gate,
    presentation: security.presentation,
    resultSanitizer: security.resultSanitizer,
  });
}

export function assertDefaultBuiltinSecurityCoverage(registry: ToolRegistry): void {
  const missing = DEFAULT_BUILTIN_TOOL_ORDER.filter((name) => {
    const resolved = registry.resolve(name);
    return (
      resolved === undefined ||
      resolved.securityFactsProjector === undefined ||
      !isValidBuiltinDefinition(resolved.definition)
    );
  });
  if (missing.length > 0) {
    throw new V1SecurityCompositionError(
      `Default Tool security coverage is incomplete: ${missing.join(", ")}`,
    );
  }
}

function isValidBuiltinDefinition(definition: ToolDefinition): boolean {
  const runtimeKinds = definition.runtimeRequirements.runtimeKinds;
  return (
    definition.name.length > 0 &&
    definition.description.length > 0 &&
    definition.requiredCapabilities.length > 0 &&
    Array.isArray(runtimeKinds) &&
    runtimeKinds.length > 0 &&
    runtimeKinds.every((kind): kind is string => typeof kind === "string") &&
    runtimeKinds.includes("local")
  );
}

export type SecureDispatcherDependencySummary = Pick<
  V1SecureToolDispatcherOptions,
  | "registry"
  | "store"
  | "notifier"
  | "clock"
  | "invocationIdFactory"
  | "observationIdFactory"
  | "eventIdFactory"
  | "approvalStore"
  | "approvalIdFactory"
>;

export type {
  ToolApprovalRequestIdFactory,
  ToolApprovalStorePort,
  ToolClock,
  ToolCommittedEventNotifier,
  ToolEventIdFactory,
  ToolExecutionStorePort,
  ToolInvocationIdFactory,
  ToolObservationIdFactory,
};
