import { z } from "zod";
import {
  ApprovalPolicySchema,
  FilesystemBoundarySchema,
  PermissionPresetIdSchema,
  PermissionProfileSchema,
  ProcessBoundarySchema,
  RequiredEnforcementSchema,
  SelectablePermissionPresetIdSchema,
} from "./policy.js";
import { WorkspaceIdSchema } from "./primitives/ids.js";

export const PermissionPresetSelectionSchema = z
  .object({
    id: SelectablePermissionPresetIdSchema,
    expectedVersion: z.number().int().positive().safe(),
  })
  .strict();
export type PermissionPresetSelection = z.infer<typeof PermissionPresetSelectionSchema>;

export const PermissionPresetDescriptorSchema = z
  .object({
    id: SelectablePermissionPresetIdSchema,
    version: z.number().int().positive().safe(),
    displayName: z.string().min(1),
    description: z.string().min(1),
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    filesystemBoundary: FilesystemBoundarySchema,
    processBoundary: ProcessBoundarySchema,
    requiredEnforcement: RequiredEnforcementSchema,
    requiresConfirmation: z.boolean(),
  })
  .strict();
export type PermissionPresetDescriptor = z.infer<typeof PermissionPresetDescriptorSchema>;

const SecurityPolicyPresetAvailabilitySchema = z
  .object({
    id: SelectablePermissionPresetIdSchema,
    version: z.number().int().positive().safe(),
    status: z.enum(["AVAILABLE", "PREPARATION_REQUIRED", "UNAVAILABLE"]),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();
export type SecurityPolicyPresetAvailability = z.infer<
  typeof SecurityPolicyPresetAvailabilitySchema
>;

const ProcessSandboxCapabilitySchema = z
  .object({
    status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    enforcement: z.enum(["HARD", "PARTIAL", "NONE"]),
    provider: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();

export const SecurityCapabilitiesResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    presets: z.array(PermissionPresetDescriptorSchema).min(1),
    defaultPreset: SelectablePermissionPresetIdSchema,
    processSandbox: ProcessSandboxCapabilitySchema,
    ttySupported: z.boolean(),
    workspacePreparationSupported: z.boolean(),
  })
  .strict();
export type SecurityCapabilitiesResponse = z.infer<typeof SecurityCapabilitiesResponseSchema>;

const WorkspacePreparationSchema = z
  .object({
    supported: z.boolean(),
    status: z.enum(["NOT_REQUIRED", "REQUIRED", "READY", "UNAVAILABLE"]),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();

export const WorkspaceSecurityCapabilitiesResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    presets: z.array(SecurityPolicyPresetAvailabilitySchema).min(1),
    preparation: WorkspacePreparationSchema,
  })
  .strict();
export type WorkspaceSecurityCapabilitiesResponse = z.infer<
  typeof WorkspaceSecurityCapabilitiesResponseSchema
>;

export const SecurityPreparationRequestSchema = z
  .object({ preset: PermissionPresetSelectionSchema })
  .strict();
export type SecurityPreparationRequest = z.infer<typeof SecurityPreparationRequestSchema>;

export const SecurityPreparationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    preset: PermissionPresetSelectionSchema,
    status: z.enum(["READY", "PREPARED", "UNAVAILABLE", "FAILED"]),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();
export type SecurityPreparationResponse = z.infer<typeof SecurityPreparationResponseSchema>;

export const RunSecurityPolicySnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    preset: z
      .object({ id: PermissionPresetIdSchema, version: z.number().int().positive().safe() })
      .strict(),
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    filesystemBoundary: FilesystemBoundarySchema,
    processBoundary: ProcessBoundarySchema,
    requiredEnforcement: RequiredEnforcementSchema,
    hardSafetyPolicyVersion: z.string().min(1),
    commandPolicyVersion: z.string().min(1),
    secretPolicyVersion: z.string().min(1),
    createdAt: z.string().min(1),
    policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type RunSecurityPolicySnapshotV1 = z.infer<typeof RunSecurityPolicySnapshotV1Schema>;

export type SecurityPolicyDigestInput = Omit<RunSecurityPolicySnapshotV1, "policyDigest"> & {
  policyDigest?: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Security policy JSON must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Security policy JSON contains an unsupported value");
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

// Kept dependency-free so Protocol remains usable by the Web host as well as Node.
function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const previous = words[index - 15]!;
      const earlier = words[index - 2]!;
      const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 = rotateRight(earlier, 17) ^ rotateRight(earlier, 19) ^ (earlier >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + constants[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

export function canonicalSecurityPolicyJson(input: SecurityPolicyDigestInput): string {
  const withoutDigest = { ...input };
  delete withoutDigest.policyDigest;
  return canonicalJson(withoutDigest);
}

export function computeSecurityPolicyDigest(input: SecurityPolicyDigestInput): string {
  return sha256Hex(canonicalSecurityPolicyJson(input));
}

export function verifySecurityPolicyDigest(snapshot: RunSecurityPolicySnapshotV1): boolean {
  return snapshot.policyDigest === computeSecurityPolicyDigest(snapshot);
}
