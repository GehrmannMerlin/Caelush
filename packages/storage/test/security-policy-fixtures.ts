export const legacySecurityPolicyFixtures = Object.freeze({
  readOnlyDangerousOnly: Object.freeze({
    permissionProfile: "READ_ONLY",
    approvalPolicy: "DANGEROUS_ONLY",
  }),
  projectAccessDangerousOnly: Object.freeze({
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
  }),
  fullAccessNeverAsk: Object.freeze({
    permissionProfile: "FULL_ACCESS",
    approvalPolicy: "NEVER_ASK",
  }),
  ambiguousNeverAsk: Object.freeze({
    permissionProfile: "READ_ONLY",
    approvalPolicy: "NEVER_ASK",
  }),
} as const);
