const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readFile, writeFile } = require("node:fs/promises");

const icon = path.join(__dirname, "resources", "caelush-app-icon.ico");
const resourceStage = path.resolve(
  process.env.CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT ?? path.join(__dirname, ".build-resources"),
);
const outputRoot = path.resolve(
  process.env.CAELUSH_DESKTOP_OUTPUT_ROOT ??
    path.join(__dirname, "..", "..", "release-artifacts", "desktop"),
);

module.exports = {
  appId: "com.caelush.desktop",
  productName: "Caelush",
  artifactName: "Caelush-${version}-dev-win-x64-Setup.${ext}",
  directories: {
    buildResources: path.join(__dirname, "resources"),
    output: outputRoot,
  },
  files: ["dist/**/*", "package.json"],
  extraResources: [
    {
      from: resourceStage,
      to: ".",
      filter: ["**/*"],
    },
  ],
  asar: true,
  npmRebuild: false,
  win: {
    icon,
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    packElevateHelper: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: "Caelush",
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
  },
  afterPack: async (context) => {
    const resourcesPath = path.join(context.appOutDir, "resources");
    const manifestPath = path.join(resourcesPath, "desktop-resource-manifest.json");
    const archivePath = path.join(resourcesPath, "app.asar");
    const manifestModule = await import(
      pathToFileURL(path.join(__dirname, "src", "shared", "resource-manifest.mjs")).href
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const completed = await manifestModule.addDesktopArchiveResource(manifest, archivePath);
    await manifestModule.verifyDesktopResourceFiles(completed, resourcesPath);
    await writeFile(manifestPath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");
  },
};
