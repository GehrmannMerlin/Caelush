import { spawn } from "node:child_process";
import { join } from "node:path";
import { PrivateReplayError } from "@caelush/agent";

// Fixed program only. Key bytes use anonymous pipes, never argv, environment, files or diagnostics.
// CurrentUser requires the same Windows user profile after restart; LocalMachine is never used.
const PROGRAM = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($request.content)
  $entropy = [Text.Encoding]::UTF8.GetBytes('caelush.replay.master.v1:' + $request.keyId)
  if ($request.operation -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  [Array]::Clear($bytes, 0, $bytes.Length)
  [Array]::Clear($result, 0, $result.Length)
} catch { exit 1 }
`;

/** Bounded host adapter over Windows' bundled .NET DPAPI wrapper. Never inherits output handles. */
export async function windowsDpapi(
  operation: "protect" | "unprotect",
  keyId: string,
  bytes: Uint8Array,
): Promise<Buffer> {
  if (
    process.platform !== "win32" ||
    bytes.byteLength > 8192 ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(keyId)
  )
    throw new PrivateReplayError();
  return new Promise((resolve, reject) => {
    const executable = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(PROGRAM, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(fail, 10000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new PrivateReplayError());
    });
    child.stdin.on("error", fail);
    child.stderr.on("data", () => {
      /* Discard native diagnostics, including command echo. */
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16384) {
        chunk.fill(0);
        fail();
      } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const encoded = Buffer.concat(chunks);
      try {
        if (failed || code !== 0 || encoded.length === 0) throw new PrivateReplayError();
        const result = Buffer.from(encoded.toString("ascii"), "base64");
        if (result.toString("base64") !== encoded.toString("ascii")) {
          result.fill(0);
          throw new PrivateReplayError();
        }
        resolve(result);
      } catch {
        reject(new PrivateReplayError());
      } finally {
        encoded.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    });
    child.stdin.end(
      JSON.stringify({ operation, keyId, content: Buffer.from(bytes).toString("base64") }),
    );
  });
}
