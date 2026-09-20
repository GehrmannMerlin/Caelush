import type { ApprovalRequest, RunId, ToolInvocationId } from "@caelush/protocol";
import type { ToolApprovalLookupPort as CanonicalApprovalLookupPort } from "@caelush/agent";

import type { ToolApprovalLookupPort } from "./dispatcher-ports.js";

/**
 * Adapt the legacy approval lookup onto the canonical admission port.
 *
 * ```text
 * canonical getStoredApprovalKey        the question the durable coordinator asks
 * legacy    getApprovalKeyByInvocation  the same question, under its historical name
 * ```
 *
 * One durable approval identity, two spellings. A Storage repository may implement either — most
 * implement the legacy one — and this adapter makes the canonical port answerable without giving the
 * repository a second method that would have to agree with the first.
 *
 * ## "Cannot answer" is not "nothing stored"
 *
 * A repository that implements **neither** method cannot be asked the question at all, and the adapter
 * reports that honestly instead of answering `null`. The two are different facts: `null` says "no
 * identity is stored for this invocation", which is a comparison the coordinator can make; the absent
 * answer says "this host cannot compare identities", which the coordinator refuses to read as a match.
 * Collapsing them would turn a missing lookup into a silent pass.
 */
export function toCanonicalApprovalLookup(
  approvals: ToolApprovalLookupPort,
): CanonicalApprovalLookupPort {
  return {
    getByInvocation(toolInvocationId: ToolInvocationId): Promise<ApprovalRequest | null> {
      return approvals.getByInvocation(toolInvocationId);
    },
    async getStoredApprovalKey(
      toolInvocationId: ToolInvocationId,
    ): Promise<string | null | undefined> {
      if (approvals.getStoredApprovalKey !== undefined) {
        return await approvals.getStoredApprovalKey(toolInvocationId);
      }
      if (approvals.getApprovalKeyByInvocation !== undefined) {
        return await approvals.getApprovalKeyByInvocation(toolInvocationId);
      }
      return undefined;
    },
    findApplicableRunGrant(input: {
      readonly runId: RunId;
      readonly approvalKey: string;
    }): Promise<ApprovalRequest | null> {
      return approvals.findApplicableRunGrant(input);
    },
  };
}
