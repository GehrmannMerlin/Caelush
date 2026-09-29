import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushToolExecutionGate, SecurityPolicyInvariantError } from "../src/index.js";

const invocation = {
  id: createToolInvocationId(),
  runId: createRunId(),
  stepId: createStepId(),
  toolName: "apply_patch" as const,
  externalCallId: "call-1",
  args: {
    patch: "SECRET_COMMAND_9A_123 SECRET_PATH_9A_456 SECRET_TOKEN_9A_789",
  },
  riskLevel: "HIGH" as const,
  status: "REQUESTED" as const,
  createdAt: createTimestampMs(1),
};

const definition = {
  name: "apply_patch" as const,
  riskLevel: "HIGH" as const,
  requiredCapabilities: ["FS_WRITE", "FS_DELETE"] as const,
  runtimeRequirements: { runtimeKinds: ["local"] },
};

describe("Caelush Tool execution Gate", () => {
  it("converts a Tool boundary request into a policy decision", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
    });

    expect(decision).toMatchObject({ kind: "ALLOW", reasonCode: "ALLOWED_BY_POLICY" });
  });

  it("fails closed for a Tool risk metadata mismatch without leaking arguments", async () => {
    await expect(
      new CaelushToolExecutionGate().decide({
        invocation,
        toolName: definition.name,
        definition: { ...definition, riskLevel: "LOW" },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
      }),
    ).rejects.toBeInstanceOf(SecurityPolicyInvariantError);
    await expect(
      new CaelushToolExecutionGate().decide({
        invocation,
        toolName: definition.name,
        definition: { ...definition, riskLevel: "LOW" },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
      }),
    ).rejects.not.toThrow("SECRET_");
  });

  it("fails closed for malformed Gate input without exposing implementation errors", async () => {
    await expect(new CaelushToolExecutionGate().decide(null as never)).rejects.toMatchObject({
      name: "SecurityPolicyInvariantError",
      message: "Security policy invariant was violated.",
    });
    await expect(
      new CaelushToolExecutionGate().decide({
        invocation,
        toolName: definition.name,
        definition: { ...definition, runtimeRequirements: "bad" },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
      } as never),
    ).rejects.toMatchObject({
      name: "SecurityPolicyInvariantError",
      message: "Security policy invariant was violated.",
    });
  });

  it("tightens a base allow decision for a sensitive resource", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation: { ...invocation, riskLevel: "LOW" },
      toolName: definition.name,
      definition: { ...definition, riskLevel: "LOW" },
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "DANGEROUS_ONLY" },
      securityFacts: {
        resourceAccesses: [{ operation: "WRITE", path: ".env" }],
        secretScanInputs: [],
      },
    });

    expect(decision).toMatchObject({
      kind: "REQUIRE_APPROVAL",
      reasonCode: "SENSITIVE_RESOURCE_REQUIRES_REVIEW",
    });
  });

  it("turns input review into denial under NEVER_ASK", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
      securityFacts: {
        resourceAccesses: [{ operation: "WRITE", path: ".env" }],
        secretScanInputs: [],
      },
    });

    expect(decision).toMatchObject({
      kind: "DENY",
      reasonCode: "SENSITIVE_RESOURCE_BLOCKED_WITHOUT_APPROVAL",
    });
  });

  it("does not downgrade a base denial when input facts are ordinary", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "READ_ONLY", approvalPolicy: "NEVER_ASK" },
      securityFacts: {
        resourceAccesses: [{ operation: "READ", path: "src/app.ts" }],
        secretScanInputs: [],
      },
    });

    expect(decision).toMatchObject({
      kind: "DENY",
      reasonCode: "MISSING_REQUIRED_CAPABILITY",
    });
  });

  it("creates a secret-safe command preview without carrying the raw command", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "DANGEROUS_ONLY" },
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

    expect(decision.safeAction).toMatchObject({ kind: "SHELL_COMMAND", tty: false });
    expect(JSON.stringify(decision.safeAction)).not.toContain("SECRET_APPROVAL_9C_TOKEN");
  });

  it("fails closed when Security Facts are structurally malformed", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
      securityFacts: { resourceAccesses: "not-an-array", secretScanInputs: [] },
    } as never);

    expect(decision).toMatchObject({ kind: "DENY", reasonCode: "SECURITY_FACTS_UNAVAILABLE" });
  });
});

/**
 * The process-safety boundary, at the gate a Tool call actually passes through.
 *
 * A shell-level process kill cannot prove ownership of the process it targets, so it is never an
 * approval question: `exec_command` must be denied outright. The DENY must hold under *every*
 * approval policy, including the permissive one, because an approval prompt would imply a human can
 * supply the ownership proof the command cannot carry.
 */
describe("Caelush Tool execution Gate — host-process termination", () => {
  const execInvocation = {
    ...invocation,
    toolName: "exec_command" as const,
    riskLevel: "CRITICAL" as const,
    args: { cmd: "taskkill /F /IM node.exe" },
  };
  const execDefinition = {
    name: "exec_command" as const,
    riskLevel: "CRITICAL" as const,
    requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"] as const,
    runtimeRequirements: { runtimeKinds: ["local"] },
  };

  function commandFacts(command: string) {
    return {
      resourceAccesses: [],
      shellCommand: { command, workdir: ".", tty: false },
      secretScanInputs: [{ kind: "COMMAND", text: command }],
    };
  }

  it.each([
    "taskkill /F /IM node.exe",
    "taskkill /PID 1234 /F",
    "Stop-Process -Name node -Force",
    'powershell -Command "Stop-Process -Name node -Force"',
    "pkill -f node",
    "killall node",
    "kill -9 1234",
  ])("denies %s under the permissive DANGEROUS_ONLY policy", async (command) => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation: { ...execInvocation, args: { cmd: command } },
      toolName: execDefinition.name,
      definition: execDefinition,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "DANGEROUS_ONLY" },
      securityFacts: commandFacts(command),
    });

    expect(decision).toMatchObject({
      kind: "DENY",
      reasonCode: "SYSTEM_DESTRUCTIVE_COMMAND_DENIED",
    });
  });

  it("keeps an ordinary build or test command out of the destructive path", async () => {
    for (const command of ["npm test", "pnpm build", "node server.js", "git status"]) {
      const decision = await new CaelushToolExecutionGate().decide({
        invocation: { ...execInvocation, args: { cmd: command } },
        toolName: execDefinition.name,
        definition: execDefinition,
        securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "DANGEROUS_ONLY" },
        securityFacts: commandFacts(command),
      });

      expect(decision.reasonCode, command).not.toBe("SYSTEM_DESTRUCTIVE_COMMAND_DENIED");
      expect(JSON.stringify(decision.safeAction ?? {}), command).not.toContain("SYSTEM_DESTRUCTIVE");
    }
  });
});
