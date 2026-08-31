import type { VerificationCheck } from "@caelush/protocol";
import { createVerificationCandidate } from "./candidate.js";
import type { ProjectCheckResolution } from "./contracts.js";
import type { ProjectCheckResolver, VerificationProjectProfile } from "./resolver.js";

const RUST_COMMANDS = {
  TYPECHECK: ["check", "--offline"],
  TEST: ["test", "--offline"],
  BUILD: ["build", "--offline"],
} as const;

export const rustProjectCheckResolver: ProjectCheckResolver & { readonly ecosystem: "RUST" } = {
  ecosystem: "RUST",

  resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution {
    if (check.spec.kind !== "PROJECT" || !profile.ecosystems.includes("RUST")) {
      return { kind: "UNAVAILABLE", reason: "ECOSYSTEM_UNSUPPORTED" };
    }
    if (check.spec.purpose === "LINT") {
      return { kind: "UNAVAILABLE", reason: "TOOLING_UNAVAILABLE" };
    }
    const cargo = profile.tooling.find((item) => item.name === "cargo");
    const args = RUST_COMMANDS[check.spec.purpose];
    if (cargo === undefined || args === undefined || cargo.evidencePaths.length === 0) {
      return { kind: "UNAVAILABLE", reason: "TOOLING_UNAVAILABLE" };
    }
    const label = `project ${check.spec.purpose.toLowerCase()}`;
    return {
      kind: "READY",
      candidate: createVerificationCandidate({
        checkId: check.id,
        executable: "cargo",
        args,
        workdir: ".",
        provenance: {
          ecosystem: "RUST",
          resolver: "RUST_CARGO@phase-11b.v1",
          evidencePath: cargo.evidencePaths[0]!,
        },
        securityInputs: [
          { kind: "COMMAND", label, body: ["cargo", ...args].join(" "), workdir: "." },
        ],
      }),
    };
  },
};
