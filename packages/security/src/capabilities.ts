import { CapabilitySchema, type Capability, type PermissionProfile } from "@caelush/protocol";

const READ_ONLY_CAPABILITIES = ["FS_READ", "GIT_READ"] as const satisfies readonly Capability[];
const PROJECT_ACCESS_CAPABILITIES = [
  "FS_READ",
  "FS_WRITE",
  "FS_DELETE",
  "SHELL_EXEC",
  "PROCESS_START",
  "PROCESS_KILL",
  "GIT_READ",
] as const satisfies readonly Capability[];
const ALL_CAPABILITIES = CapabilitySchema.options;

class ImmutableCapabilitySet implements ReadonlySet<Capability> {
  private readonly set: ReadonlySet<Capability>;

  constructor(values: readonly Capability[]) {
    this.set = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.set.size;
  }

  has(value: Capability): boolean {
    return this.set.has(value);
  }

  entries(): ReturnType<ReadonlySet<Capability>["entries"]> {
    return this.set.entries();
  }

  keys(): ReturnType<ReadonlySet<Capability>["keys"]> {
    return this.set.keys();
  }

  values(): ReturnType<ReadonlySet<Capability>["values"]> {
    return this.set.values();
  }

  forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
  ): void {
    this.set.forEach((value) => callbackfn(value, value, this));
  }

  [Symbol.iterator](): ReturnType<ReadonlySet<Capability>["values"]> {
    return this.set.values();
  }
}

const GRANTED_CAPABILITIES: Readonly<Record<PermissionProfile, ReadonlySet<Capability>>> = {
  READ_ONLY: new ImmutableCapabilitySet(READ_ONLY_CAPABILITIES),
  PROJECT_ACCESS: new ImmutableCapabilitySet(PROJECT_ACCESS_CAPABILITIES),
  FULL_ACCESS: new ImmutableCapabilitySet(ALL_CAPABILITIES),
};

export function resolveGrantedCapabilities(profile: PermissionProfile): ReadonlySet<Capability> {
  return GRANTED_CAPABILITIES[profile];
}
