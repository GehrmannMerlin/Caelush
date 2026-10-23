import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDesktopResourceManifestCompatible,
  computeResourceSetDigest,
  validateDesktopResourceManifest,
  verifyDesktopResourceFiles,
} from "../../src/shared/resource-manifest.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Desktop resource manifest", () => {
  it.each([
    "/absolute.exe",
    "D:/absolute.exe",
    "daemon/../outside.exe",
    "daemon\\node.exe",
    "daemon/CON.exe",
    "daemon/node.exe:stream",
    "daemon/node.exe.",
    "daemon/control\u0001.exe",
  ])("rejects the ambiguous Windows resource path %s", (resourcePath) => {
    const manifest = fixtureManifest();
    expect(() =>
      validateDesktopResourceManifest({
        ...manifest,
        resourceFiles: [{ ...manifest.resourceFiles[0], path: resourcePath }],
      }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
  });

  it("binds Runner, PTY native content, and Web digest to the declared file records", () => {
    const manifest = fixtureManifest();
    expect(() =>
      validateDesktopResourceManifest({
        ...manifest,
        sandboxRunner: { ...manifest.sandboxRunner, sha256: "f".repeat(64) },
      }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
    expect(() =>
      validateDesktopResourceManifest({
        ...manifest,
        sandboxRunner: { ...manifest.sandboxRunner, controlProtocolVersion: 2 },
      }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
    expect(() =>
      validateDesktopResourceManifest({
        ...manifest,
        nativeModules: [
          {
            ...manifest.nativeModules[0],
            files: [{ ...manifest.nativeModules[0].files[0], sha256: "f".repeat(64) }],
          },
        ],
      }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
    expect(() =>
      validateDesktopResourceManifest({ ...manifest, webAssetDigest: "f".repeat(64) }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
  });

  it("rejects traversal paths, absolute paths, and unsupported manifest identities", () => {
    const manifest = fixtureManifest();
    expect(() =>
      validateDesktopResourceManifest({
        ...manifest,
        resourceFiles: [{ ...manifest.resourceFiles[0], path: "../outside.exe" }],
      }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
    expect(() =>
      validateDesktopResourceManifest({
        ...manifest,
        resourceFiles: [{ ...manifest.resourceFiles[0], path: "C:/outside.exe" }],
      }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
    expect(() =>
      assertDesktopResourceManifestCompatible(manifest, { productVersion: "1.0.0" }),
    ).toThrow("DESKTOP_RESOURCE_VERSION_MISMATCH");
    expect(() =>
      assertDesktopResourceManifestCompatible(manifest, { nodeVersion: "25.0.0" }),
    ).toThrow("DESKTOP_RESOURCE_NODEVERSION_MISMATCH");
    expect(() =>
      assertDesktopResourceManifestCompatible(manifest, { daemonVersion: "0.2.0" }),
    ).toThrow("DESKTOP_RESOURCE_DAEMONVERSION_MISMATCH");
    expect(() =>
      validateDesktopResourceManifest({
        ...manifest,
        nativeModules: [{ ...manifest.nativeModules[0], version: "1.2.0" }],
      }),
    ).toThrow("DESKTOP_RESOURCE_MANIFEST_INVALID");
  });

  it("verifies the complete file set and detects missing or changed resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-resource-manifest-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "daemon", "node_modules", "node-pty", "prebuilds", "win32-x64"), {
      recursive: true,
    });
    await mkdir(join(root, "web", "desktop"), { recursive: true });
    await mkdir(join(root, "sandbox-runner"), { recursive: true });
    await writeFile(join(root, "daemon", "node.exe"), "node-runtime");
    await writeFile(
      join(root, "daemon", "node_modules", "node-pty", "prebuilds", "win32-x64", "conpty.node"),
      "native-addon",
    );
    await writeFile(join(root, "web", "desktop", "index.html"), "<main>Caelush</main>");
    await writeFile(join(root, "sandbox-runner", "caelush-sandbox-runner.exe"), "runner-binary");
    const manifest = fixtureManifest();

    await expect(verifyDesktopResourceFiles(manifest, root)).resolves.toEqual({
      verifiedFiles: 4,
      resourceSetDigest: manifest.resourceSetDigest,
    });
    await writeFile(join(root, "daemon", "node.exe"), "modified-node");
    await expect(verifyDesktopResourceFiles(manifest, root)).rejects.toThrow(
      "DESKTOP_RESOURCE_FILE_HASH_MISMATCH",
    );
    await writeFile(join(root, "daemon", "node.exe"), "node-runtime");
    await rm(join(root, "web", "desktop", "index.html"));
    await expect(verifyDesktopResourceFiles(manifest, root)).rejects.toThrow(
      "DESKTOP_RESOURCE_FILE_MISSING:web/desktop/index.html",
    );
    await writeFile(join(root, "web", "desktop", "index.html"), "<main>Caelush</main>");
    await writeFile(join(root, "unexpected.bin"), "not declared");
    await expect(verifyDesktopResourceFiles(manifest, root)).rejects.toThrow(
      "DESKTOP_RESOURCE_FILE_SET_MISMATCH",
    );
    await rm(join(root, "unexpected.bin"));
    await writeFile(join(root, "sandbox-runner", "caelush-sandbox-runner.exe"), "tampered-runner");
    await expect(verifyDesktopResourceFiles(manifest, root)).rejects.toThrow(
      "DESKTOP_RESOURCE_FILE_HASH_MISMATCH",
    );
  });
});

function fixtureManifest() {
  const files = [
    file("daemon/node.exe", "node-runtime", "EXECUTABLE", "node-v24.18.0-win32-x64"),
    file(
      "daemon/node_modules/node-pty/prebuilds/win32-x64/conpty.node",
      "native-addon",
      "NATIVE_ADDON",
      "node-pty-1.2.0-beta.14-win32-x64-napi-10",
    ),
    file(
      "sandbox-runner/caelush-sandbox-runner.exe",
      "runner-binary",
      "SANDBOX_RUNNER",
      "protocol-1",
    ),
    file("web/desktop/index.html", "<main>Caelush</main>", "WEB_ASSET", "desktop-web"),
  ];
  return validateDesktopResourceManifest({
    schemaVersion: 1,
    product: "Caelush",
    productVersion: "0.1.0",
    channel: "dev",
    platform: "win32",
    architecture: "x64",
    electronVersion: "44.7.0",
    daemonVersion: "0.1.0",
    apiVersion: "v1",
    protocolVersion: 1,
    nodeVersion: "24.18.0",
    nodeExecutableSha256: files[0].sha256,
    webAssetDigest: digestFiles(files.filter((entry) => entry.path.startsWith("web/desktop/"))),
    desktopAssetDigest: "b".repeat(64),
    nativeModules: [
      {
        name: "node-pty",
        version: "1.2.0-beta.14",
        platform: "win32",
        architecture: "x64",
        nodeAbi: "137",
        napiVersion: "10",
        files: [{ path: files[1].path, sha256: files[1].sha256 }],
      },
    ],
    sandboxRunner: {
      path: "sandbox-runner/caelush-sandbox-runner.exe",
      controlProtocolVersion: 1,
      platform: "windows",
      architecture: "x64",
      sha256: files[2].sha256,
      providers: ["windows-acl-restricted-token"],
    },
    requiredCapabilities: ["desktopHostAuthV1"],
    resourceFiles: files,
    resourceSetDigest: digestFiles(files),
  });
}

function file(path: string, content: string, fileType: string, runtimeIdentity: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    fileType,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    runtimeIdentity,
  };
}

function digestFiles(files: readonly { path: string; size: number; sha256: string }[]): string {
  return computeResourceSetDigest(files);
}
