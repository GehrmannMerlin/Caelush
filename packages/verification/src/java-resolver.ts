import type { VerificationCheck } from "@caelush/protocol";
import { createVerificationCandidate } from "./candidate.js";
import type { ProjectCheckResolution } from "./contracts.js";
import type { ProjectCheckResolver, VerificationProjectProfile } from "./resolver.js";

const JAVA_COMMANDS = {
  maven: {
    executable: "mvn",
    TEST: ["-o", "test"],
    BUILD: ["-o", "-DskipTests", "package"],
  },
  gradle: {
    executable: "gradle",
    TEST: ["--offline", "test"],
    BUILD: ["--offline", "build"],
  },
} as const;

export const javaProjectCheckResolver: ProjectCheckResolver & { readonly ecosystem: "JAVA" } = {
  ecosystem: "JAVA",

  resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution {
    if (check.spec.kind !== "PROJECT" || !profile.ecosystems.includes("JAVA")) {
      return { kind: "UNAVAILABLE", reason: "ECOSYSTEM_UNSUPPORTED" };
    }
    if (check.spec.purpose === "LINT" || check.spec.purpose === "TYPECHECK") {
      return { kind: "UNAVAILABLE", reason: "TOOLING_UNAVAILABLE" };
    }
    const tools = profile.tooling.filter((item) => item.name === "maven" || item.name === "gradle");
    if (tools.length !== 1 || tools[0]!.evidencePaths.length === 0) {
      return { kind: "UNAVAILABLE", reason: "TOOLING_UNAVAILABLE" };
    }
    const toolName = tools[0]!.name as keyof typeof JAVA_COMMANDS;
    const tool = JAVA_COMMANDS[toolName];
    const args = tool[check.spec.purpose];
    if (args === undefined) return { kind: "UNAVAILABLE", reason: "TOOLING_UNAVAILABLE" };
    const label = `project ${check.spec.purpose.toLowerCase()}`;
    return {
      kind: "READY",
      candidate: createVerificationCandidate({
        checkId: check.id,
        executable: tool.executable,
        args,
        workdir: ".",
        provenance: {
          ecosystem: "JAVA",
          resolver: `JAVA_${toolName.toUpperCase()}@phase-11b.v1`,
          evidencePath: tools[0]!.evidencePaths[0]!,
        },
        securityInputs: [
          { kind: "COMMAND", label, body: [tool.executable, ...args].join(" "), workdir: "." },
        ],
      }),
    };
  },
};
