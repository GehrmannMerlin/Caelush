import { describe, expect, it } from "vitest";
import { evaluateHardSafety, type CommandEffectAssessment } from "../src/index.js";

type EffectOverrides = Omit<
  Partial<CommandEffectAssessment>,
  "filesystem" | "process" | "network" | "privilege" | "system" | "secrets" | "execution"
> & {
  readonly filesystem?: Partial<CommandEffectAssessment["filesystem"]>;
  readonly process?: Partial<CommandEffectAssessment["process"]>;
  readonly network?: Partial<CommandEffectAssessment["network"]>;
  readonly privilege?: Partial<CommandEffectAssessment["privilege"]>;
  readonly system?: Partial<CommandEffectAssessment["system"]>;
  readonly secrets?: Partial<CommandEffectAssessment["secrets"]>;
  readonly execution?: Partial<CommandEffectAssessment["execution"]>;
};

const effect = (overrides: EffectOverrides = {}): CommandEffectAssessment => ({
  confidence: "EXACT",
  ...overrides,
  filesystem: {
    reads: [],
    writes: [],
    deletes: [],
    unknownTargets: false,
    ...overrides.filesystem,
  },
  process: {
    spawnsChildren: false,
    longRunning: false,
    targetsManagedProcessIds: [],
    targetsUnmanagedProcesses: false,
    ...overrides.process,
  },
  network: {
    mayAccessNetwork: false,
    knownDestinations: [],
    remoteMutation: false,
    ...overrides.network,
  },
  privilege: {
    requestsElevation: false,
    modifiesIdentityOrPermissions: false,
    ...overrides.privilege,
  },
  system: {
    powerControl: false,
    diskOrPartitionMutation: false,
    serviceMutation: false,
    securityPolicyMutation: false,
    rawDeviceAccess: false,
    ...overrides.system,
  },
  secrets: {
    readsKnownSecretMaterial: false,
    sendsDataToNetwork: false,
    detectedTaintIds: [],
    ...overrides.secrets,
  },
  execution: { dynamicEvaluation: false, opaqueBinary: false, ...overrides.execution },
});

describe("hard safety policy", () => {
  it.each([
    ["power", { system: { powerControl: true } }],
    ["disk", { system: { diskOrPartitionMutation: true } }],
    ["raw device", { system: { rawDeviceAccess: true } }],
    ["service", { system: { serviceMutation: true } }],
    ["security policy", { system: { securityPolicyMutation: true } }],
    ["elevation", { privilege: { requestsElevation: true } }],
    ["unmanaged process", { process: { targetsUnmanagedProcesses: true } }],
    ["secret exfiltration", { secrets: { sendsDataToNetwork: true, detectedTaintIds: ["t1"] } }],
  ] as const)("denies %s before approval", (_name, overrides) => {
    const decision = evaluateHardSafety(effect(overrides));
    expect(decision.kind).toBe("DENY");
  });

  it("allows ordinary Full Access effects when hard rules do not apply", () => {
    expect(evaluateHardSafety(effect()).kind).toBe("ALLOW");
  });
});
