import { describe, expect, it } from "vitest";
import { evaluateHardSafety, type CommandEffectAssessment } from "../src/index.js";

const effect = (overrides: Partial<CommandEffectAssessment> = {}): CommandEffectAssessment => ({
  confidence: "EXACT",
  filesystem: { reads: [], writes: [], deletes: [], unknownTargets: false },
  process: {
    spawnsChildren: false,
    longRunning: false,
    targetsManagedProcessIds: [],
    targetsUnmanagedProcesses: false,
  },
  network: { mayAccessNetwork: false, knownDestinations: [], remoteMutation: false },
  privilege: { requestsElevation: false, modifiesIdentityOrPermissions: false },
  system: {
    powerControl: false,
    diskOrPartitionMutation: false,
    serviceMutation: false,
    securityPolicyMutation: false,
    rawDeviceAccess: false,
  },
  secrets: { readsKnownSecretMaterial: false, sendsDataToNetwork: false, detectedTaintIds: [] },
  execution: { dynamicEvaluation: false, opaqueBinary: false },
  ...overrides,
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
