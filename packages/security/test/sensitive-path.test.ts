import { describe, expect, it } from "vitest";
import { classifySensitivePath } from "../src/index.js";

describe("SensitivePathClassifier", () => {
  it.each([
    [".env", "ENVIRONMENT_FILE"],
    [".env.local", "ENVIRONMENT_FILE"],
    ["config\\.ENV.production", "ENVIRONMENT_FILE"],
    [".npmrc", "AUTH_CONFIG"],
    [".netrc", "CREDENTIAL_FILE"],
    [".git-credentials", "CREDENTIAL_FILE"],
    ["id_rsa", "PRIVATE_KEY"],
    ["keys/server.key", "PRIVATE_KEY"],
    ["client.p12", "CERTIFICATE_CONTAINER"],
    [".aws/credentials", "CLOUD_CREDENTIAL_FILE"],
    [".kube/config", "CLOUD_CREDENTIAL_FILE"],
    [".docker/config.json", "CLOUD_CREDENTIAL_FILE"],
  ])("classifies %s as %s", (path, category) => {
    expect(classifySensitivePath(path)).toBe(category);
  });

  it.each([".env.example", ".env.sample", ".env.template", ".env.defaults", ".env.local.example", "src/config.example.ts"])(
    "does not classify template-like path %s as sensitive",
    (path) => {
      expect(classifySensitivePath(path)).toBeUndefined();
    },
  );

  it.each(["C:\\workspace\\.env", "/tmp/.env", "../.env", "src/../.env"])(
    "does not treat invalid workspace path %s as a direct sensitive match",
    (path) => {
      expect(classifySensitivePath(path)).toBeUndefined();
    },
  );
});
