import { RuntimeSandboxError } from "../runtime-errors.js";
import type { RuntimeProcessPolicy } from "../security/runtime-boundary.js";
import type { ProcessSandboxProbe, ProcessSandboxProvider } from "./contracts.js";
import { createUnrestrictedProcessSandboxProvider } from "./unrestricted-provider.js";

export function selectProcessSandbox(
  policy: RuntimeProcessPolicy,
  probes: readonly ProcessSandboxProbe[],
): ProcessSandboxProvider {
  if (policy.requiredEnforcement === "HARD_SAFETY_ONLY") {
    if (
      policy.processBoundary !== "UNRESTRICTED" ||
      policy.filesystem.boundary !== "HOST_USER_SCOPE"
    ) {
      throw new RuntimeSandboxError(
        "Full Access policy must explicitly select unrestricted host scope.",
      );
    }
    const unrestricted = probes.find(
      (probe) => probe.available && probe.provider.kind === "UNRESTRICTED",
    );
    return unrestricted?.provider ?? createUnrestrictedProcessSandboxProvider();
  }

  if (policy.processBoundary === "UNRESTRICTED") {
    throw new RuntimeSandboxError(
      "Restricted policy cannot request an unrestricted process boundary.",
    );
  }
  const candidates = probes
    .filter(
      (probe) =>
        probe.available &&
        probe.provider.kind === "RESTRICTED" &&
        probe.enforcement !== "NONE" &&
        probe.provider.enforcement !== "NONE",
    )
    .sort((left, right) => enforcementRank(right.enforcement) - enforcementRank(left.enforcement));
  const selected = candidates[0]?.provider;
  if (selected === undefined) {
    throw new RuntimeSandboxError("A required restricted process sandbox provider is unavailable.");
  }
  return selected;
}

function enforcementRank(value: ProcessSandboxProbe["enforcement"]): number {
  return value === "HARD" ? 2 : value === "PARTIAL" ? 1 : 0;
}
