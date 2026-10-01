export interface SecurityFeatureGates {
  readonly permissionPresetsV1: boolean;
  readonly runtimeSandboxV1: boolean;
  readonly fullAccessV1: boolean;
}

export interface SecurityFeatureGateInspection {
  readonly gates: SecurityFeatureGates;
  readonly invalid: readonly (keyof SecurityFeatureGates)[];
}

const ENVIRONMENT_KEYS: Readonly<Record<keyof SecurityFeatureGates, string>> = {
  permissionPresetsV1: "CAELUSH_FEATURE_PERMISSION_PRESETS_V1",
  runtimeSandboxV1: "CAELUSH_FEATURE_RUNTIME_SANDBOX_V1",
  fullAccessV1: "CAELUSH_FEATURE_FULL_ACCESS_V1",
};

const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

/** Resolve host rollout gates without ever turning malformed configuration into enablement. */
export function inspectSecurityFeatureGates(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SecurityFeatureGateInspection {
  const invalid: (keyof SecurityFeatureGates)[] = [];
  const readGate = (key: keyof SecurityFeatureGates): boolean => {
    const raw = environment[ENVIRONMENT_KEYS[key]]?.trim().toLowerCase();
    if (raw === undefined || raw.length === 0 || ENABLED_VALUES.has(raw)) return true;
    if (DISABLED_VALUES.has(raw)) return false;
    invalid.push(key);
    return false;
  };
  const gates: SecurityFeatureGates = {
    permissionPresetsV1: readGate("permissionPresetsV1"),
    runtimeSandboxV1: readGate("runtimeSandboxV1"),
    fullAccessV1: readGate("fullAccessV1"),
  };
  return { gates, invalid: Object.freeze(invalid) };
}

export function resolveSecurityFeatureGates(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SecurityFeatureGates {
  return inspectSecurityFeatureGates(environment).gates;
}

export const SECURITY_FEATURE_GATE_ENVIRONMENT_KEYS = Object.freeze({ ...ENVIRONMENT_KEYS });
