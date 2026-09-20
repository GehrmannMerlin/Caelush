import type { ToolDefinition, ToolName } from "@caelush/protocol";
import {
  type ToolExecutionUpdateSanitizerPort,
  type TransientToolUpdateConsumer,
  type TransientToolUpdateDiagnostics,
} from "@caelush/agent";
import {
  createToolExecutionDependencies,
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
  "gate" | "execution" | "presentation" | "approvalStore" | "approvalIdFactory"
> {
  readonly approvalStore: ToolApprovalStorePort;
  readonly approvalIdFactory: ToolApprovalRequestIdFactory;
  readonly terminalOutputSanitizer: TerminalOutputSanitizer;
  readonly securityToolNames?: readonly ToolName[];
  /**
   * The transient update sanitizer for this composition.
   *
   * Supplied rather than defaulted: the executor binds it before any Tool runs, so a composition that
   * forgot one would forward nothing and prove nothing. The production daemon passes
   * `new CaelushToolExecutionUpdateSanitizer()`; a test that only needs the durable path passes its
   * own trivial implementation.
   */
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
  /** Where sanitized transient updates go. Absent means the Agent layer's discarding consumer. */
  readonly transientUpdates?: TransientToolUpdateConsumer | undefined;
  readonly updateDiagnostics?: TransientToolUpdateDiagnostics | undefined;
}
/**
 * The production V1 Secure Tool dispatcher.
 *
 * ```text
 * legacy ToolRegistry  →  createV1SecureToolDispatcher  →  ToolDispatcher
 *                                                            ├─ canonical ToolCallPreparer
 *                                                            ├─ canonical ToolInvocationExecutor
 *                                                            └─ canonical ToolResultPipeline
 * ```
 *
 * This factory is the one place the production composition builds a `ToolDispatcher`, and it is where
 * the canonical execution authority is bound:
 *
 * ```text
 * invocationExecutorFactory  createToolInvocationExecutor (invocation-bound)
 * updateSanitizer            the caller's transient update sanitizer
 * resultPipeline             createToolResultPipeline with the real result sanitizer and limits
 * ```
 *
 * The result pipeline receives the same `CaelushToolResultSanitizer` the previous shell used, now
 * behind the canonical port, and the Coding settlement bridge, so effect projection still happens
 * after sanitization and still settles in the invocation's own atomic commit.
 *
 * `normalization` is the registration-level argument compatibility normalization for the Tools the
 * composition root registered (the legacy definitions that rely on schema-declared numeric strings).
 * It is supplied by the caller rather than imported here, because the composition root is the layer
 * that knows which Tool set it built; this factory must not guess one.
 */
export function createV1SecureToolDispatcher(
  options: V1SecureToolDispatcherOptions,
): ToolDispatcher {
  assertDefaultBuiltinSecurityCoverage(options.registry, options.securityToolNames);
  const security = createDefaultV1ToolExecutionSecurity({
    terminalOutputSanitizer: options.terminalOutputSanitizer,
  });
  return new ToolDispatcher({
    ...options,
    gate: security.gate,
    presentation: security.presentation,
    execution: {
      ...createToolExecutionDependencies({
        registry: options.registry,
        resultSanitizer: security.resultSanitizer,
        updateSanitizer: options.updateSanitizer,
        ...(options.transientUpdates === undefined
          ? {}
          : { transientUpdates: options.transientUpdates }),
        ...(options.updateDiagnostics === undefined
          ? {}
          : { updateDiagnostics: options.updateDiagnostics }),
        ...(options.outputPolicy === undefined ? {} : { outputPolicy: options.outputPolicy }),
      }),
    },
  });
}

export function assertDefaultBuiltinSecurityCoverage(
  registry: ToolRegistry,
  expectedToolNames: readonly ToolName[] = DEFAULT_BUILTIN_TOOL_ORDER,
): void {
  const missing = expectedToolNames.filter((name) => {
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
