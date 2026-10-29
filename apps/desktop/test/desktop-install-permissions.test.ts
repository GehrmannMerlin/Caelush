import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER_INCLUDE = path.join(APP_ROOT, "resources", "installer.nsh");
const require = createRequire(import.meta.url);

describe("Windows installer sandbox read permissions", () => {
  it("includes the dedicated NSIS hook in the Windows installer", () => {
    const config = require(path.join(APP_ROOT, "electron-builder.config.cjs"));

    expect(config.nsis.include).toBe(INSTALLER_INCLUDE);
  });

  it("grants only inherited read/execute access to the selected install directory", async () => {
    expect(existsSync(INSTALLER_INCLUDE)).toBe(true);
    const source = await readFile(INSTALLER_INCLUDE, "utf8");

    expect(source).toContain("!macro customInstall");
    expect(source).toContain(
      'ExecWait \'"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)"\' $0',
    );
    expect(source).not.toMatch(/\/grant:r|\/reset|\/inheritance:r/i);
    expect(source).not.toMatch(/\/T\b/i);
    expect(source).toContain('IfFileExists "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(source).toContain('IfFileExists "$INSTDIR\\icudtl.dat"');
    expect(source).toContain('IfFileExists "$INSTDIR\\resources\\app.asar"');
    expect(source).toContain("StrCmp $R9 $R8 caelushInstallAclInvalidPath");
    expect(source).toContain("$TEMP\\Caelush-install-permissions.log");
    expect(source).toContain("SetErrorLevel 1");
    expect(source).toContain("Abort");
    expect(source).toContain("MessageBox MB_ICONSTOP|MB_OK");
  });
});
