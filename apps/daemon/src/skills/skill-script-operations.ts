import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  RunWorkflowExecutionProfileV1Schema,
  type ReadOnlyResourcePolicy,
  type RunId,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import {
  MAX_READ_ONLY_RESOURCE_GRANT_LIFETIME_MS,
  authorizeReadOnlyResource,
  redactText,
} from "@caelush/security";
import type {
  SkillScriptEvaluationContext,
  SkillScriptOperationInput,
  SkillScriptOperationResult,
  SkillOperations,
} from "@caelush/coding-agent";
import {
  createAuthorizedRuntimeExecution,
  createRuntimeProcessPolicy,
  sanitizeTerminalOutput,
  RuntimeUnsupportedError,
  type RuntimeResolver,
} from "@caelush/runtime";
import type { RunRepository, StepRepository } from "@caelush/storage";
import { parseSkillManifest } from "@caelush/skills";
import type { RunSkillCatalogSnapshotService } from "./run-catalog-snapshot.js";
import type { FilesystemSkillBundleStore } from "./bundle-store.js";
import { SkillBundleStoreError } from "./bundle-store.js";
import { SkillOperationError } from "@caelush/coding-agent";
import { createSkillFileFingerprint, normalizeSkillRelativePath } from "./skill-package.js";
import { WORKFLOW_RENDERER_VERSION } from "./selected-skill-preparer.js";
import type { SecurityCapabilityService } from "../services/security-capability-service.js";

const SCRIPT_RUNTIME_METADATA_KEY = "caelush.scriptRuntime";
const MAX_SCRIPT_ARGUMENTS = 64;
const MAX_SCRIPT_ARGUMENT_UTF8_BYTES = 4096;
const HOST_PATH =
  /(?:[A-Za-z]:[\\/]{1,2}|\\\\[^\s\\/]+[\\/]|\/(?:Users|home|root|var|etc|opt|tmp)\/)/u;

export interface RunSkillScriptOperationsOptions {
  readonly runs: Pick<
    RunRepository,
    "get" | "readWorkflowProfile" | "readPreparedResources" | "readPreparedInputReceipts"
  >;
  readonly steps: Pick<StepRepository, "get">;
  readonly snapshots: Pick<RunSkillCatalogSnapshotService, "readRunSkillCatalogSnapshot">;
  readonly bundles: Pick<FilesystemSkillBundleStore, "read" | "resolveExecutionResource">;
  readonly runtimeResolver: RuntimeResolver;
  readonly securityCapabilityService: Pick<
    SecurityCapabilityService,
    "selectRuntimeProcessProvider"
  >;
}

/**
 * Execute a Node script only from a verified, Run-bound bundle resource.
 *
 * The model selects a binding, script-relative path and independent argv strings. The interpreter,
 * resource root, grant and executable path are all resolved from daemon-owned state immediately
 * before Runtime dispatch.
 */
export function createRunSkillScriptOperations(
  options: RunSkillScriptOperationsOptions,
): SkillOperations["runScript"] {
  return async (
    input: SkillScriptOperationInput,
    evaluationContext: SkillScriptEvaluationContext,
  ): Promise<SkillScriptOperationResult> => {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (input.runId !== evaluationContext.identity.runId) {
      throw new SkillOperationError("SKILL_BINDING_INACTIVE");
    }
    if (
      input.args.length > MAX_SCRIPT_ARGUMENTS ||
      input.args.some(
        (argument) =>
          argument.includes("\0") ||
          Buffer.byteLength(argument, "utf8") > MAX_SCRIPT_ARGUMENT_UTF8_BYTES,
      ) ||
      (input.yieldTimeMs !== undefined &&
        (!Number.isSafeInteger(input.yieldTimeMs) ||
          input.yieldTimeMs < 250 ||
          input.yieldTimeMs > 30_000))
    ) {
      throw new SkillOperationError("SKILL_SCRIPT_DENIED");
    }
    const run = await options.runs.get(input.runId);
    if (run === null) throw new SkillOperationError("SKILL_NOT_FOUND");
    if (
      run.workspace.id !== evaluationContext.environment.workspace.id ||
      resolve(run.workspace.path) !== resolve(evaluationContext.environment.workspace.path)
    ) {
      throw new SkillOperationError("SKILL_WORKSPACE_MISMATCH");
    }
    const { skill, binding } = await readActiveBinding(options, input, evaluationContext);
    const resourcePath = normalizeScriptPath(input.resourcePath);
    const workdir = normalizeWorkspaceRelativeWorkdir(input.workdir);
    const manifest = await readBoundManifest(options, skill, input.signal);
    if (manifest.metadata?.[SCRIPT_RUNTIME_METADATA_KEY] !== "node") {
      throw new SkillOperationError("SKILL_SCRIPT_INTERPRETER_UNAVAILABLE");
    }
    const extension = extname(resourcePath).toLocaleLowerCase("en-US");
    if (extension !== ".mjs" && extension !== ".cjs") {
      throw new SkillOperationError("SKILL_SCRIPT_INTERPRETER_UNAVAILABLE");
    }

    let frozenResource;
    try {
      frozenResource = await options.bundles.resolveExecutionResource({
        bundle: skill.bundle,
        relativePath: resourcePath,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof SkillBundleStoreError) {
        throw new SkillOperationError(
          error.code === "SKILL_RESOURCE_DENIED" ? "SKILL_SCRIPT_DENIED" : "SKILL_CORE_INVALID",
        );
      }
      throw new SkillOperationError("SKILL_CORE_INVALID");
    }
    if (
      frozenResource.bundleRevision !== skill.bundle.bundleRevision ||
      frozenResource.contentManifestHash !== skill.bundle.bundleRevision.slice("sha256:".length) ||
      !/^sha256:[a-f0-9]{64}$/u.test(frozenResource.fingerprint) ||
      !pathIsWithin(frozenResource.rootDirectory, frozenResource.absolutePath)
    ) {
      throw new SkillOperationError("SKILL_CORE_INVALID");
    }
    if (input.signal.aborted) throw abortReason(input.signal);

    const securityReference = evaluationContext.securityContext?.securityPolicy;
    const persistedSecurityPolicy = run.securityPolicy;
    if (
      securityReference === undefined ||
      persistedSecurityPolicy === undefined ||
      securityReference.presetId !== persistedSecurityPolicy.preset.id ||
      securityReference.presetVersion !== persistedSecurityPolicy.preset.version ||
      securityReference.policyDigest !== persistedSecurityPolicy.policyDigest ||
      securityReference.filesystemBoundary !== persistedSecurityPolicy.filesystemBoundary ||
      securityReference.processBoundary !== persistedSecurityPolicy.processBoundary ||
      securityReference.requiredEnforcement !== persistedSecurityPolicy.requiredEnforcement
    ) {
      throw new SkillOperationError("SKILL_SCRIPT_DENIED");
    }
    if (
      securityReference.processBoundary !== "WORKSPACE_WRITE" ||
      securityReference.filesystemBoundary !== "WORKSPACE_READ_WRITE" ||
      securityReference.requiredEnforcement !== "OS_RESTRICTED"
    ) {
      return { kind: "UNAVAILABLE" };
    }
    // The only Runtime provider that currently proves immutable resource ACL enforcement is the
    // Windows native runner. Other platforms fail closed until their provider proves the same grant.
    if (process.platform !== "win32") {
      throw new SkillOperationError("SKILL_SCRIPT_UNAVAILABLE");
    }
    try {
      await access(process.execPath);
    } catch {
      return { kind: "UNAVAILABLE" };
    }

    const resourceIdentity = Object.freeze({
      resourceId: binding.bindingId,
      bundleRevision: binding.resourceRevision,
      canonicalRoot: frozenResource.rootDirectory.replaceAll("\\", "/"),
      contentManifestHash: frozenResource.contentManifestHash,
    });
    const now = Date.now();
    const resourcePolicy: ReadOnlyResourcePolicy = Object.freeze({
      runId: input.runId,
      revision: `${securityReference.policyDigest}:${binding.resourceRevision}`,
      enabled: true,
      expiresAt: now + MAX_READ_ONLY_RESOURCE_GRANT_LIFETIME_MS,
      resources: Object.freeze([resourceIdentity]),
    });
    const grantDecision = authorizeReadOnlyResource(
      { runId: input.runId, ...resourceIdentity },
      resourcePolicy,
      now,
    );
    if (grantDecision.kind !== "ALLOW") {
      throw new SkillOperationError("SCRIPT_EXECUTION_UNAVAILABLE");
    }

    const policy = createRuntimeProcessPolicy({
      runId: input.runId,
      workspaceId: run.workspace.id,
      workspaceRoot: run.workspace.path,
      filesystemBoundary: securityReference.filesystemBoundary,
      processBoundary: securityReference.processBoundary,
      requiredEnforcement: securityReference.requiredEnforcement,
      readOnlyResources: resourcePolicy,
    });
    const provider = await options.securityCapabilityService.selectRuntimeProcessProvider(policy);
    const authorization = createAuthorizedRuntimeExecution({
      policy,
      provider,
      authorizationNonce: createAuthorizationNonce({
        runId: input.runId,
        policyDigest: securityReference.policyDigest,
        bindingId: binding.bindingId,
        bundleRevision: binding.resourceRevision,
      }),
    });
    const runtime = options.runtimeResolver.resolve(evaluationContext.environment.runtime);
    if (runtime === undefined) throw new RuntimeUnsupportedError();
    const scope = await runtime.openWorkspace(run.workspace, {
      processAuthorization: authorization,
    });
    const result = await scope.exec.executeArgvAuthorized({
      ownerRunId: input.runId,
      executable: process.execPath,
      args: [frozenResource.absolutePath, ...input.args],
      workdir,
      yieldTimeMs: input.yieldTimeMs ?? 10_000,
      signal: input.signal,
      authorization,
      readOnlyResourceGrant: grantDecision.grant,
      ...(input.onOutput === undefined
        ? {}
        : {
            onOutput: (event: { readonly stream: "stdout" | "stderr"; readonly text: string }) =>
              input.onOutput?.(event.stream, event.text),
          }),
    });
    return Object.freeze({
      kind: "EXECUTED" as const,
      status: result.status,
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      output: safeScriptOutput(result.output),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      totalOutputBytes: result.totalOutputBytes,
      omittedBytes: result.omittedBytes,
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    });
  };
}

async function readActiveBinding(
  options: RunSkillScriptOperationsOptions,
  input: SkillScriptOperationInput,
  context: SkillScriptEvaluationContext,
): Promise<{
  readonly skill: Awaited<ReturnType<typeof readRunSkillSnapshot>>["snapshot"]["skills"][number];
  readonly binding: WorkflowResourceBindingV1;
}> {
  const frozen = await readRunSkillSnapshot(options, input.runId, input.signal);
  if (options.runs.readPreparedResources === undefined) {
    throw new SkillOperationError("SKILL_BINDING_INACTIVE");
  }
  const bindings = await options.runs.readPreparedResources(input.runId);
  const binding = bindings.find(({ bindingId }) => bindingId === input.bindingId);
  if (
    binding === undefined ||
    binding.runId !== input.runId ||
    binding.resourceKind !== "WORKFLOW_INSTRUCTION"
  ) {
    throw new SkillOperationError("SKILL_BINDING_INACTIVE");
  }
  const skill = frozen.snapshot.skills.find(({ skillId }) => skillId === binding.resourceId);
  if (
    skill === undefined ||
    !skill.enabled ||
    !skill.modelInvocable ||
    skill.bundle.bundleRevision !== binding.resourceRevision ||
    skill.bundle.artifactRef !== binding.artifactRef ||
    skill.bundle.manifestFingerprint !== binding.sourceFingerprint
  ) {
    throw new SkillOperationError("SKILL_BINDING_INACTIVE");
  }
  await requirePreparedReceipt(
    options,
    input.runId,
    context,
    binding,
    frozen.profile.workflowRendererVersion,
  );
  return { skill, binding };
}

async function requirePreparedReceipt(
  options: RunSkillScriptOperationsOptions,
  runId: RunId,
  context: SkillScriptEvaluationContext,
  binding: WorkflowResourceBindingV1,
  rendererVersion: string,
): Promise<void> {
  if (options.runs.readPreparedInputReceipts === undefined || options.steps.get === undefined) {
    throw new SkillOperationError("SKILL_PREPARATION_REQUIRED");
  }
  const [requestedStep, receipts] = await Promise.all([
    options.steps.get(context.identity.sourceStepId),
    options.runs.readPreparedInputReceipts(runId),
  ]);
  if (requestedStep === null || requestedStep.runId !== runId) {
    throw new SkillOperationError("SKILL_PREPARATION_REQUIRED");
  }
  const matching = receipts.filter(({ bindingId }) => bindingId === binding.bindingId);
  for (const receipt of matching) {
    if (
      receipt.runId !== runId ||
      receipt.rendererVersion !== rendererVersion ||
      !/^sha256:[a-f0-9]{64}$/u.test(receipt.projectionFingerprint)
    ) {
      throw new SkillOperationError("SKILL_PREPARATION_REQUIRED");
    }
    const preparedStep = await options.steps.get(receipt.stepId);
    if (
      preparedStep !== null &&
      preparedStep.runId === runId &&
      preparedStep.sequence <= requestedStep.sequence &&
      (preparedStep.status === "RUNNING" || preparedStep.status === "COMPLETED")
    ) {
      return;
    }
  }
  throw new SkillOperationError("SKILL_PREPARATION_REQUIRED");
}

async function readBoundManifest(
  options: RunSkillScriptOperationsOptions,
  skill: Awaited<ReturnType<typeof readRunSkillSnapshot>>["snapshot"]["skills"][number],
  signal: AbortSignal,
) {
  try {
    const resource = await options.bundles.read({
      bundle: skill.bundle,
      relativePath: "SKILL.md",
      signal,
    });
    if (
      resource.kind !== "TEXT" ||
      !resource.complete ||
      resource.relativePath !== "SKILL.md" ||
      resource.fingerprint !== skill.bundle.manifestFingerprint ||
      createSkillFileFingerprint(new TextEncoder().encode(resource.text)) !==
        skill.bundle.manifestFingerprint
    ) {
      throw new SkillOperationError("SKILL_CORE_INVALID");
    }
    const parsed = parseSkillManifest(resource.text);
    if (
      !parsed.ok ||
      parsed.manifest.name !== skill.name ||
      parsed.manifest.description !== skill.description
    ) {
      throw new SkillOperationError("SKILL_CORE_INVALID");
    }
    return parsed.manifest;
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof SkillOperationError) throw error;
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
}

async function readRunSkillSnapshot(
  options: RunSkillScriptOperationsOptions,
  runId: RunId,
  signal: AbortSignal,
) {
  if (options.runs.readWorkflowProfile === undefined) {
    throw new SkillOperationError("SKILL_BINDING_INACTIVE");
  }
  const run = await options.runs.get(runId);
  if (run === null) throw new SkillOperationError("SKILL_NOT_FOUND");
  const rawProfile = await options.runs.readWorkflowProfile(runId);
  let profile;
  try {
    profile = RunWorkflowExecutionProfileV1Schema.parse(rawProfile);
  } catch {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  if (profile.runId !== runId || profile.workflowRendererVersion !== WORKFLOW_RENDERER_VERSION) {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  let snapshot;
  try {
    snapshot = await options.snapshots.readRunSkillCatalogSnapshot(profile.catalogSnapshotRef);
  } catch {
    if (signal.aborted) throw abortReason(signal);
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  if (
    snapshot.workspaceId !== run.workspace.id ||
    snapshot.catalogRevision !== profile.catalogSnapshotRef.catalogRevision ||
    snapshot.artifactRef !== profile.catalogSnapshotRef.artifactRef ||
    snapshot.manifestFingerprint !== profile.catalogSnapshotRef.manifestFingerprint ||
    snapshot.complete !== true
  ) {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  if (signal.aborted) throw abortReason(signal);
  return Object.freeze({ run, profile, snapshot });
}

function normalizeScriptPath(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeSkillRelativePath(value);
  } catch {
    throw new SkillOperationError("SKILL_SCRIPT_DENIED");
  }
  if (normalized.split("/")[0] !== "scripts") {
    throw new SkillOperationError("SKILL_SCRIPT_DENIED");
  }
  return normalized;
}

function normalizeWorkspaceRelativeWorkdir(value: string | undefined): string {
  if (value === undefined || value === ".") return ".";
  if (
    value.length > 1024 ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new SkillOperationError("SKILL_SCRIPT_DENIED");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new SkillOperationError("SKILL_SCRIPT_DENIED");
  }
  return parts.join("/");
}

function createAuthorizationNonce(input: {
  readonly runId: RunId;
  readonly policyDigest: string;
  readonly bindingId: string;
  readonly bundleRevision: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([input.runId, input.policyDigest, input.bindingId, input.bundleRevision]),
      "utf8",
    )
    .digest("hex");
  return `${input.runId}:${digest}`;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function safeScriptOutput(value: string): string {
  const sanitized = redactText(sanitizeTerminalOutput(value));
  return HOST_PATH.test(sanitized)
    ? "[Script output withheld because it contained a host path.]"
    : sanitized;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Skill script execution was cancelled.", "AbortError");
}
