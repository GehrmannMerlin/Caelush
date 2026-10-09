import { createHash } from "node:crypto";
import type { RunSecurityPolicySnapshotV1 } from "@caelush/protocol";
import type { RunSecurityRuntimeFacts } from "./security-capability-service.js";

export interface SystemContextBlock {
  readonly id: "agent.security-policy";
  readonly source: "RUN_SECURITY_POLICY";
  readonly sensitivity: "PUBLIC";
  readonly text: string;
}

/**
 * Model-facing identity for the security semantics and runtime capabilities described below.
 * Keep this separate from policyDigest: the latter authenticates the complete, timestamped
 * snapshot and remains the authority for security validation.
 */
function computePolicySemanticFingerprint(
  policy: RunSecurityPolicySnapshotV1,
  runtimeFacts: RunSecurityRuntimeFacts,
): string {
  // A fixed ordered tuple gives us canonical bytes independent of source object property order.
  // JSON.stringify is deterministic for this tuple, including its UTF-8 Unicode strings.
  const canonicalInput = JSON.stringify([
    ["projection", "run-security-prompt@1"],
    ["schemaVersion", policy.schemaVersion],
    ["preset.id", policy.preset.id],
    ["preset.version", policy.preset.version],
    ["permissionProfile", policy.permissionProfile],
    ["approvalPolicy", policy.approvalPolicy],
    ["filesystemBoundary", policy.filesystemBoundary],
    ["processBoundary", policy.processBoundary],
    ["requiredEnforcement", policy.requiredEnforcement],
    ["hardSafetyPolicyVersion", policy.hardSafetyPolicyVersion],
    ["commandPolicyVersion", policy.commandPolicyVersion],
    ["secretPolicyVersion", policy.secretPolicyVersion],
    ["runtimeKind", runtimeFacts.runtimeKind],
    ["sandboxProvider", runtimeFacts.sandboxProvider],
    ["sandboxEnforcement", runtimeFacts.enforcement],
    ["ttySupported", runtimeFacts.ttySupported],
  ]);

  return `sha256:${createHash("sha256").update(canonicalInput, "utf8").digest("hex")}`;
}

/**
 * Projects the frozen Run policy into synthetic system context. The block contains only policy
 * enums, stable semantic identity, and bounded host capability facts; it is never appended to the
 * durable AgentMessage history and it never contains a workspace path, command, environment value,
 * or secret.
 */
export class RunSecurityPromptProjector {
  project(
    policy: RunSecurityPolicySnapshotV1,
    runtimeFacts: RunSecurityRuntimeFacts,
  ): SystemContextBlock {
    const policySemanticFingerprint = computePolicySemanticFingerprint(policy, runtimeFacts);
    const approvalInstruction =
      policy.approvalPolicy === "NEVER_ASK"
        ? "do not wait for approval; if the Security decision is not allowed, treat the action as denied and stop"
        : "request approval only when the Security decision explicitly requires it; approval cannot expand this Run's authority";
    const boundaryInstruction =
      policy.preset.id === "VIEW_ONLY"
        ? "read project content and metadata only; never attempt a mutation"
        : policy.preset.id === "WORKSPACE_WRITE"
          ? "normal writes stay inside the selected workspace boundary; external, network, install, publish, and remote effects remain subject to Security"
          : "host-user-scope file, process, network, install, publish, and remote work may be allowed, but hard safety denials still apply";

    const text = [
      "<run_security_policy>",
      `preset=${policy.preset.id}@${String(policy.preset.version)}`,
      `permission_profile=${policy.permissionProfile}`,
      `approval_policy=${policy.approvalPolicy}`,
      `filesystem_boundary=${policy.filesystemBoundary}`,
      `process_boundary=${policy.processBoundary}`,
      `required_enforcement=${policy.requiredEnforcement}`,
      `hard_safety_policy_version=${policy.hardSafetyPolicyVersion}`,
      `command_policy_version=${policy.commandPolicyVersion}`,
      `secret_policy_version=${policy.secretPolicyVersion}`,
      `runtime=${runtimeFacts.runtimeKind}`,
      `sandbox_provider=${runtimeFacts.sandboxProvider}`,
      `sandbox_enforcement=${runtimeFacts.enforcement}`,
      `tty_supported=${String(runtimeFacts.ttySupported)}`,
      `policy_semantic_fingerprint=${policySemanticFingerprint}`,
      `Boundary rule: ${boundaryInstruction}.`,
      `Approval rule: ${approvalInstruction}.`,
      "Hard safety denials always win: power control, raw disk or device mutation, privilege or service/security-policy mutation, unmanaged process termination, protected-root destruction, unresolved recursive deletion, and detectable secret-to-network exfiltration remain denied.",
      "If a Tool or Runtime reports a boundary or hard-safety denial, do not retry the same effect through another Tool or shell spelling.",
      "Full Access still cannot make opaque third-party binaries safe; opaque third-party binaries may hide file reads or encrypted network exfiltration beyond observation.",
      "</run_security_policy>",
    ].join("\n");
    return Object.freeze({
      id: "agent.security-policy",
      source: "RUN_SECURITY_POLICY",
      sensitivity: "PUBLIC",
      text,
    });
  }
}
