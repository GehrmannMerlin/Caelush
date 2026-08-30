export type SensitivePathCategory =
  | "ENVIRONMENT_FILE"
  | "CREDENTIAL_FILE"
  | "PRIVATE_KEY"
  | "AUTH_CONFIG"
  | "CLOUD_CREDENTIAL_FILE"
  | "CERTIFICATE_CONTAINER";

const TEMPLATE_SUFFIX = /(?:^|\.)(?:example|sample|template|defaults?)$/i;
const ENVIRONMENT_FILE = /^\.env(?:\..+)?$/i;
const AUTH_CONFIG_NAMES = new Set([".npmrc", ".pypirc"]);
const CREDENTIAL_NAMES = new Set([".netrc", ".git-credentials", ".authinfo", "credentials.json"]);
const PRIVATE_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);

export function normalizeWorkspaceFactPath(path: string): string | undefined {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === "..")
  ) {
    return undefined;
  }
  return normalized;
}

export function classifySensitivePath(path: string): SensitivePathCategory | undefined {
  const normalized = normalizeWorkspaceFactPath(path);
  if (normalized === undefined) return undefined;
  const lower = normalized.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  if (ENVIRONMENT_FILE.test(basename) && !TEMPLATE_SUFFIX.test(basename.slice(5))) {
    return "ENVIRONMENT_FILE";
  }
  if (AUTH_CONFIG_NAMES.has(basename)) return "AUTH_CONFIG";
  if (CREDENTIAL_NAMES.has(basename)) return "CREDENTIAL_FILE";
  if (PRIVATE_KEY_NAMES.has(basename) || basename.endsWith(".key")) return "PRIVATE_KEY";
  if (basename.endsWith(".p12") || basename.endsWith(".pfx")) {
    return "CERTIFICATE_CONTAINER";
  }
  if (lower === ".aws/credentials" || lower === ".kube/config" || lower === ".docker/config.json") {
    return "CLOUD_CREDENTIAL_FILE";
  }
  if (lower.split("/").includes(".ssh")) return "PRIVATE_KEY";
  return undefined;
}

export function isValidWorkspaceFactPath(path: string): boolean {
  return normalizeWorkspaceFactPath(path) !== undefined;
}
