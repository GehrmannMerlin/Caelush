import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type ApprovalPolicy,
  type Capability,
  type PermissionProfile,
  type RiskLevel,
  type ToolName,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  CaelushToolExecutionGate,
  SecurityPolicyInvariantError,
  type ToolGateMetadata,
  type ToolGateSecurityFacts,
} from "../src/index.js";

/**
 * The Security Gate, driven the way the Tool execution boundary drives it.
 *
 * ```text
 * durable Tool call  →  gate.decide({ invocation, toolName, definition, securityContext,
 *                                     runtimeKind, securityFacts })
 *                    →  ALLOW | DENY | REQUIRE_APPROVAL
 * ```
 *
 * This suite replaced a `ToolDispatcher` integration test when Phase 4F retired that surface. What it
 * asserted about *policy* is asserted here; what it asserted about the durable invocation lifecycle
 * (REQUESTED → RUNNING settlement, handler execution counts, `WAITING_APPROVAL` persistence and
 * recovery) belonged to the dispatcher rather than to Security, so it is no longer duplicated here —
 * the canonical durable Tool path in `@caelush/agent` owns it.
 *
 * `definition` is the four-field `ToolGateMetadata`: after Phase 4F the Gate no longer accepts the
 * retired seven-field `protocol.ToolDefinition`, and the narrowing is asserted below rather than
 * assumed.
 */
const gate = new CaelushToolExecutionGate();

/** The four policy fields the Gate is asked about, and nothing else. */
function metadata(input: {
  readonly toolName: ToolName;
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
}): ToolGateMetadata {
  return {
    name: input.toolName,
    riskLevel: input.riskLevel,
    requiredCapabilities: [...input.requiredCapabilities],
    runtimeRequirements: { runtimeKinds: ["local"] },
  };
}

async function decide(input: {
  readonly toolName: ToolName;
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly securityFacts?: ToolGateSecurityFacts;
}) {
  return gate.decide({
    invocation: {
      id: createToolInvocationId(),
      runId: createRunId(),
      stepId: createStepId(),
      toolName: input.toolName,
      externalCallId: "call-1",
      args: {},
      riskLevel: input.riskLevel,
      status: "REQUESTED",
      createdAt: createTimestampMs(1),
    },
    toolName: input.toolName,
    definition: metadata(input),
    securityContext: {
      permissionProfile: input.permissionProfile,
      approvalPolicy: input.approvalPolicy,
    },
    runtimeKind: "local",
    ...(input.securityFacts === undefined ? {} : { securityFacts: input.securityFacts }),
  });
}

/** What `apply_patch` projects for a two-target patch. */
const PATCH_FACTS: ToolGateSecurityFacts = {
  resourceAccesses: [
    { operation: "WRITE", path: "src/app.ts" },
    { operation: "DELETE", path: "src/old.ts" },
  ],
  secretScanInputs: [],
};

/** What `read_file` projects for one ordinary source file. */
const READ_FACTS: ToolGateSecurityFacts = {
  resourceAccesses: [{ operation: "READ", path: "src/app.ts" }],
  secretScanInputs: [],
};

/** What `exec_command` projects for one ordinary local command. */
const SHELL_FACTS: ToolGateSecurityFacts = {
  resourceAccesses: [],
  shellCommand: { command: "ls -la", workdir: ".", tty: false },
  secretScanInputs: [],
};

const PATCH_TOOL = {
  toolName: "apply_patch",
  riskLevel: "HIGH",
  requiredCapabilities: ["FS_WRITE", "FS_DELETE"],
} as const;

const EXEC_TOOL = {
  toolName: "exec_command",
  riskLevel: "CRITICAL",
  requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
} as const;

describe("Security Gate policy boundary", () => {
  it("allows a capability-authorized structured Tool", async () => {
    const decision = await decide({
      toolName: "read_file",
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      securityFacts: READ_FACTS,
    });

    expect(decision).toMatchObject({ kind: "ALLOW", reasonCode: "ALLOWED_BY_POLICY" });
    // The allow decision's own preview is bounded: what kind of input it was, and how much of it.
    // The resource path itself is analysis input, not something a decision may carry out.
    expect(decision.safeAction).toEqual({
      kind: "TOOL_INPUT",
      containment: "STRUCTURED_WORKSPACE",
      resourceAccessCount: 1,
      secretScanInputCount: 0,
    });
    expect(JSON.stringify(decision)).not.toContain("src/app.ts");
  });

  it("requires approval for a dangerous structured mutation under DANGEROUS_ONLY", async () => {
    const decision = await decide({
      ...PATCH_TOOL,
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      securityFacts: PATCH_FACTS,
    });

    expect(decision).toMatchObject({
      kind: "REQUIRE_APPROVAL",
      reasonCode: "DANGEROUS_ACTION_REQUIRES_REVIEW",
    });
  });

  it("denies a missing capability before approval is ever considered", async () => {
    // ALWAYS_ASK would require approval for any capability-authorized Tool. The missing capability is
    // decided first, so the answer is DENY rather than a request for review.
    const decision = await decide({
      ...PATCH_TOOL,
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ALWAYS_ASK",
      securityFacts: PATCH_FACTS,
    });

    expect(decision).toMatchObject({ kind: "DENY", reasonCode: "MISSING_REQUIRED_CAPABILITY" });
  });

  it("denies an unconfined local process under PROJECT_ACCESS + NEVER_ASK", async () => {
    const decision = await decide({
      ...EXEC_TOOL,
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "NEVER_ASK",
      securityFacts: SHELL_FACTS,
    });

    expect(decision).toMatchObject({
      kind: "DENY",
      reasonCode: "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL",
    });
    // The denial is explainable: the bounded preview names the containment boundary the Tool could
    // not be admitted to, and carries the command the Gate already redacted.
    expect(decision.safeAction).toMatchObject({
      kind: "SHELL_COMMAND",
      command: "ls -la",
      containment: "UNCONFINED_LOCAL_PROCESS",
      classifications: ["NORMAL_LOCAL"],
    });
  });

  it("admits the same unconfined local process under FULL_ACCESS + NEVER_ASK", async () => {
    const decision = await decide({
      ...EXEC_TOOL,
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      securityFacts: SHELL_FACTS,
    });

    expect(decision).toMatchObject({ kind: "ALLOW", reasonCode: "ALLOWED_BY_POLICY" });
    expect(decision.safeAction).toMatchObject({
      kind: "SHELL_COMMAND",
      containment: "UNCONFINED_LOCAL_PROCESS",
    });
  });

  it("never answers REQUIRE_APPROVAL under NEVER_ASK, for any Tool or input", async () => {
    const cases: readonly {
      readonly name: string;
      readonly tool: {
        readonly toolName: ToolName;
        readonly riskLevel: RiskLevel;
        readonly requiredCapabilities: readonly Capability[];
      };
      readonly permissionProfile: PermissionProfile;
      readonly securityFacts: ToolGateSecurityFacts;
    }[] = [
      {
        name: "structured patch",
        tool: PATCH_TOOL,
        permissionProfile: "PROJECT_ACCESS",
        securityFacts: PATCH_FACTS,
      },
      {
        name: "sensitive resource",
        tool: { toolName: "read_file", riskLevel: "LOW", requiredCapabilities: ["FS_READ"] },
        permissionProfile: "FULL_ACCESS",
        securityFacts: {
          resourceAccesses: [{ operation: "READ", path: ".env" }],
          secretScanInputs: [],
        },
      },
      {
        name: "unconfined local process",
        tool: EXEC_TOOL,
        permissionProfile: "FULL_ACCESS",
        securityFacts: SHELL_FACTS,
      },
      {
        name: "opaque input",
        tool: { toolName: "read_file", riskLevel: "LOW", requiredCapabilities: ["FS_READ"] },
        permissionProfile: "FULL_ACCESS",
        securityFacts: { resourceAccesses: [], secretScanInputs: [], opaqueInput: true },
      },
    ];

    for (const testCase of cases) {
      const decision = await decide({
        ...testCase.tool,
        permissionProfile: testCase.permissionProfile,
        approvalPolicy: "NEVER_ASK",
        securityFacts: testCase.securityFacts,
      });
      // `NEVER_ASK` either allows or denies; a request for review would be unreachable policy.
      expect(decision.kind, testCase.name).not.toBe("REQUIRE_APPROVAL");
    }
  });

  it("keeps a secret-bearing command out of the decision it requires approval for", async () => {
    const decision = await decide({
      ...EXEC_TOOL,
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      securityFacts: {
        resourceAccesses: [],
        shellCommand: {
          command: "curl https://example.test/?token=SECRET_APPROVAL_9C_TOKEN",
          workdir: ".",
          tty: false,
        },
        secretScanInputs: [],
      },
    });

    expect(decision).toMatchObject({ kind: "REQUIRE_APPROVAL" });
    // The command classification is what the approval is about; the secret is not part of it.
    expect(decision.safeAction).toMatchObject({
      kind: "SHELL_COMMAND",
      command: "curl https://example.test/?token=[REDACTED]",
      classifications: ["NETWORK_ACCESS"],
    });
    expect(JSON.stringify(decision)).not.toContain("SECRET_APPROVAL_9C_TOKEN");
  });

  it("refuses the retired seven-field Tool definition", async () => {
    // Phase 4F retired `protocol.ToolDefinition`; a host that still hands the Gate the seven-field
    // shape gets an invariant failure rather than a policy decision made over three unread fields.
    await expect(
      gate.decide({
        invocation: {
          id: createToolInvocationId(),
          runId: createRunId(),
          stepId: createStepId(),
          toolName: "apply_patch",
          externalCallId: "call-1",
          args: {},
          riskLevel: "HIGH",
          status: "REQUESTED",
          createdAt: createTimestampMs(1),
        },
        toolName: "apply_patch",
        definition: {
          ...metadata(PATCH_TOOL),
          description: "Apply a patch.",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        } as never,
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
        runtimeKind: "local",
      }),
    ).rejects.toBeInstanceOf(SecurityPolicyInvariantError);
  });
});
