import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DesktopUpdateError } from "./error.js";
import { UpdateStateStore, type PendingUpdateRecord } from "./state-store.js";
import { verifyPolicyResponse, type UpdateTrust } from "../cloud/update-policy.js";

/** Fixed code runs in an independent Windows process; config is private Main-created data.
 * FileShare.Read denies both writes and deletion from final SHA-512 through NSIS exit.
 * No Cloud/Renderer arguments become code or command line options. */
const HANDOFF_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$phase='ROOT'
$ackReady=$false
trap { if($ackReady){$e=$_.Exception;while($null -ne $e.InnerException){$e=$e.InnerException};WriteAck 'REJECTED' $phase ($e.HResult -band 65535)};exit 3 }
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function AssertPath([string]$p,[bool]$directory) {
  $item=Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory) { throw 'UNSAFE_PATH' }
  $walk=$item
  while($null -ne $walk) { if(($walk.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'REPARSE_PATH'}; $walk=$walk.Parent }
}
function AssertPrivate([string]$p,[bool]$directory) {
  AssertPath $p $directory
  $acl=if($directory){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}
  $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
  $allowed=$false
  foreach($rule in $rules) {
    if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -ne $sid) {throw 'UNSAFE_ACL'}
    if(($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {$allowed=$true}
  }
  if(-not $allowed){throw 'UNSAFE_ACL'}
}
$configPath=$env:CAELUSH_D72_HANDOFF_CONFIG
$root=[IO.Path]::GetDirectoryName($configPath)
AssertPrivate $root $true
$phase='CONFIG'
AssertPrivate $configPath $false
$configLock=[IO.File]::Open($configPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$reader=New-Object IO.StreamReader($configLock)
$c=$reader.ReadToEnd() | ConvertFrom-Json
$id=[guid]::Parse($c.transactionId).ToString()
$installer=[IO.Path]::Combine($root,$c.installerName)
if($c.installerName -notmatch '^[0-9a-f-]{36}\.exe$' -or [IO.Path]::GetFileName($configPath) -ne ($id+'.handoff.json') -or $c.sha512 -notmatch '^[a-f0-9]{128}$' -or $c.size -le 0 -or $c.size -gt 1073741824) {throw 'IDENTITY_INVALID'}
function WriteAck($status,$stage,$systemCode) {
  $data=@{transactionId=$id;helperPid=$PID;status=$status}
  if($status -eq 'REJECTED'){$data.stage=$stage;$data.systemCode=$systemCode}
  $temp=[IO.Path]::Combine($root,([guid]::NewGuid().ToString()+'.tmp'))
  $f=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $bytes=[Text.Encoding]::UTF8.GetBytes(($data|ConvertTo-Json -Compress));$f.Write($bytes,0,$bytes.Length);$f.Flush($true);$f.Dispose()
  [IO.File]::Move($temp,[IO.Path]::Combine($root,$id+'.ack.json'))
}
$ackReady=$true
function AssertPolicyTime {
  if($c.expiresAtUnixMs -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()){throw 'POLICY_EXPIRED'}
}
AssertPrivate $installer $false
$phase='FILE_LOCK'
$locked=[IO.File]::Open($installer,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$phase='HASH'
$hash=[Security.Cryptography.SHA512]::Create()
$digest=[BitConverter]::ToString($hash.ComputeHash($locked)).Replace('-','').ToLowerInvariant()
if($locked.Length -ne $c.size -or $digest -ne $c.sha512) {throw 'INTEGRITY_FAILED'}
$phase='INSTALLER_IDENTITY'
$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($installer)
if($version.ProductName -ne 'Caelush' -or $version.ProductVersion -ne $c.targetVersion) {throw 'INSTALLER_VERSION_IDENTITY_INVALID'}
$phase='REGISTRY'
$registration=Get-ItemProperty -LiteralPath ('HKCU:\Software\'+$c.appGuid)
$uninstall=Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$c.appGuid)
if([IO.Path]::GetFullPath($registration.InstallLocation).TrimEnd('\') -ne [IO.Path]::GetFullPath($c.installDirectory).TrimEnd('\') -or $uninstall.DisplayVersion -ne $c.sourceVersion -or $uninstall.DisplayName -ne ('Caelush '+$c.sourceVersion)) {throw 'CURRENT_USER_INSTALL_IDENTITY_INVALID'}
AssertPrivate $installer $false
$phase='POLICY_TIME'
AssertPolicyTime
$phase='GO'
$go=[IO.Path]::Combine($root,$id+'.go')
$receipt=[IO.Path]::Combine($root,$id+'.receipt.json')
$browserSnapshot=$null
# Electron releases Chromium/LevelDB locks only after the old Main process exits.
# This is a file fingerprint, not a second policy canonicalizer or trust source.
function FingerprintBrowserTree([string]$directory,[string]$relative,$acc) {
  AssertPath $directory $true
  $entries=[IO.Directory]::GetFileSystemEntries($directory)
  [Array]::Sort($entries,[StringComparer]::Ordinal)
  foreach($entry in $entries) {
    $item=Get-Item -LiteralPath $entry -Force
    $name=[IO.Path]::GetFileName($entry)
    $rel=if($relative.Length -eq 0){$name}else{$relative+'/'+$name}
    if($item.PSIsContainer) { FingerprintBrowserTree $entry $rel $acc;continue }
    AssertPath $entry $false
    $acc.fileCount++
    if($acc.fileCount -gt 100000){throw 'BROWSER_SNAPSHOT_TOO_LARGE'}
    $stream=[IO.File]::Open($entry,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $fileHash=[Security.Cryptography.SHA256]::Create()
    try {
      $length=$stream.Length
      $digest=[BitConverter]::ToString($fileHash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()
      $bytes=[Text.Encoding]::UTF8.GetBytes($rel+[char]0+$length+[char]0+$digest+[char]10)
      [void]$acc.hash.TransformBlock($bytes,0,$bytes.Length,$bytes,0)
    } finally {$stream.Dispose();$fileHash.Dispose()}
  }
}
function CaptureBrowserSnapshot([string]$directory) {
  if([string]::IsNullOrEmpty($directory)){return $null}
  # Chromium gives its Cache an AppContainer capability ACE. Its private Profile
  # boundary stays strict; data descendants retain Chromium's sandbox ACLs.
  AssertPrivate ([IO.Path]::GetDirectoryName($directory)) $true
  $acc=@{fileCount=0;hash=[Security.Cryptography.SHA256]::Create()}
  try {
    FingerprintBrowserTree $directory '' $acc
    [void]$acc.hash.TransformFinalBlock([byte[]]@(),0,0)
    return @{digest=[BitConverter]::ToString($acc.hash.Hash).Replace('-','').ToLowerInvariant();fileCount=$acc.fileCount}
  } finally {$acc.hash.Dispose()}
}
function WriteReceipt($status,$code,$installerPid) {
  $data=@{transactionId=$id;status=$status;exitCode=$code;installerPid=$installerPid;browserSnapshot=$browserSnapshot}|ConvertTo-Json -Compress
  $temp=[IO.Path]::Combine($root,([guid]::NewGuid().ToString()+'.tmp'))
  $f=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $bytes=[Text.Encoding]::UTF8.GetBytes($data);$f.Write($bytes,0,$bytes.Length);$f.Flush($true);$f.Dispose()
  [IO.File]::Move($temp,$receipt)
}
WriteAck 'LOCKED_VERIFIED' $null $null
$ackReady=$false
$deadline=[DateTime]::UtcNow.AddSeconds(45)
while(-not [IO.File]::Exists($go)) {
  if([DateTime]::UtcNow -gt $deadline) {exit 3};Start-Sleep -Milliseconds 100
}
AssertPrivate $go $false
if(([IO.File]::ReadAllText($go)|ConvertFrom-Json).transactionId -ne $id){exit 3}
$parent=Get-Process -Id $c.parentPid -ErrorAction SilentlyContinue
if($null -ne $parent -and -not $parent.WaitForExit(45000)) {exit 3}
$installerPid=$null
try {
  $browserSnapshot=CaptureBrowserSnapshot $c.browserDirectory
  AssertPolicyTime
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$installer
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.Arguments='--updated /currentuser '+$(if($c.silent){'/S '}else{''})+'/D='+$c.installDirectory
  $child=[Diagnostics.Process]::Start($info);$installerPid=$child.Id
  $child.WaitForExit()
  $code=$child.ExitCode
  $status=if($code -eq 0){'INSTALLER_EXITED'}elseif($code -eq 1){'CANCELLED'}else{'FAILED'}
  WriteReceipt $status $code $installerPid
} catch { WriteReceipt 'FAILED' $null $installerPid }
finally { $locked.Dispose();$reader.Dispose();$hash.Dispose() }
# Exit 0 is only installer evidence. The relaunched Desktop checks version/resources/Profile.
if([IO.File]::Exists($c.executablePath)) {
  $launch=New-Object Diagnostics.ProcessStartInfo
  $launch.FileName=$c.executablePath;$launch.UseShellExecute=$false;$launch.WorkingDirectory=$c.installDirectory
  $launch.Arguments='"--user-data-dir='+$c.userDataDirectory+'"'+$(if($c.debugPort){' --remote-debugging-port='+$c.debugPort}else{''})
  $launch.CreateNoWindow=$true
  [void][Diagnostics.Process]::Start($launch)
}
`;
// DETACHED_PROCESS makes Windows PowerShell exit without running its command on supported hosts.
// Start-Process creates its own hidden console and survives the old Electron process exiting.
const HANDOFF_BOOTSTRAP = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$helper=Start-Process -FilePath ([IO.Path]::Combine($env:SystemRoot,'System32\WindowsPowerShell\v1.0\powershell.exe')) -WindowStyle Hidden -PassThru -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$env:CAELUSH_D72_HANDOFF_SCRIPT)
[Console]::Out.WriteLine($helper.Id);[Console]::Out.Flush()
`;
const HandoffAckSchema = z.discriminatedUnion("status", [
  z
    .object({
      transactionId: z.uuid(),
      helperPid: z.number().int().positive(),
      status: z.literal("LOCKED_VERIFIED"),
    })
    .strict(),
  z
    .object({
      transactionId: z.uuid(),
      helperPid: z.number().int().positive(),
      status: z.literal("REJECTED"),
      stage: z.enum([
        "ROOT",
        "CONFIG",
        "FILE_LOCK",
        "HASH",
        "INSTALLER_IDENTITY",
        "REGISTRY",
        "POLICY_TIME",
        "GO",
      ]),
      systemCode: z.number().int().min(0).max(65535),
    })
    .strict(),
]);
export async function handoffVerifiedNsis(options: {
  store: UpdateStateStore;
  pending: PendingUpdateRecord;
  trust: UpdateTrust;
  executablePath: string;
  userDataDirectory: string;
  browserDirectory: string | null;
  internalTest: boolean;
  quit: () => void;
}): Promise<void> {
  if (process.platform !== "win32" || path.basename(options.executablePath) !== "Caelush.exe")
    throw new DesktopUpdateError(
      "UPDATE_INSTALLED_APP_REQUIRED",
      "NSIS handoff requires the installed Windows application.",
    );
  const { store, pending } = options;
  const policy = verifyPolicyResponse(
    pending.responseJson,
    options.trust,
    pending.sourceVersion,
    store.accepted(options.trust.channel),
  );
  const configName = `${pending.transactionId}.handoff.json`;
  await store.atomicJson(configName, {
    transactionId: pending.transactionId,
    installerName: pending.installerName,
    size: policy.payload.release.artifactSize,
    sha512: policy.payload.release.sha512,
    expiresAtUnixMs: Date.parse(policy.payload.expiresAt),
    parentPid: process.pid,
    appGuid: installedAppGuid(),
    sourceVersion: pending.sourceVersion,
    targetVersion: pending.targetVersion,
    installDirectory: path.dirname(options.executablePath),
    executablePath: options.executablePath,
    silent: options.internalTest,
    userDataDirectory: options.userDataDirectory,
    browserDirectory: options.browserDirectory,
    debugPort: options.internalTest
      ? Number(process.argv.find((a) => /^--remote-debugging-port=\d+$/.test(a))?.split("=")[1]) ||
        null
      : null,
  });
  const child = spawn(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(HANDOFF_BOOTSTRAP, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        CAELUSH_D72_HANDOFF_CONFIG: store.file(configName),
        CAELUSH_D72_HANDOFF_SCRIPT: Buffer.from(HANDOFF_SCRIPT, "utf16le").toString("base64"),
      },
    },
  );
  const helperPid = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new DesktopUpdateError(
          "UPDATE_HANDOFF_TIMEOUT",
          "The installer lock could not be confirmed.",
        ),
      );
    }, 20000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new DesktopUpdateError(
          "UPDATE_HANDOFF_FAILED",
          "Windows could not start the verified installer handoff.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && /^\d{1,10}\s*$/.test(output) && Number(output) > 0) {
        resolve(Number(output));
        return;
      }
      reject(
        new DesktopUpdateError(
          "UPDATE_HANDOFF_FAILED",
          "Windows rejected the installer lock or file verification.",
        ),
      );
    });
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.length > 4096) {
        child.kill();
        clearTimeout(timer);
        reject(
          new DesktopUpdateError(
            "UPDATE_HANDOFF_FAILED",
            "The installer handoff returned an invalid confirmation.",
          ),
        );
      }
    });
  });
  const deadline = Date.now() + 20_000;
  while (true) {
    const raw = await store.readHandoffAck(pending.transactionId);
    if (raw !== null) {
      const parsed = HandoffAckSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.transactionId !== pending.transactionId ||
        parsed.data.helperPid !== helperPid
      )
        throw new DesktopUpdateError(
          "UPDATE_HANDOFF_FAILED",
          "The installer handoff returned an invalid confirmation.",
        );
      if (parsed.data.status === "REJECTED")
        throw new DesktopUpdateError(
          `UPDATE_HANDOFF_${parsed.data.stage}`,
          `Windows rejected the installer handoff during ${parsed.data.stage} (system code ${parsed.data.systemCode}). The installed application and Profile are preserved.`,
        );
      break;
    }
    if (Date.now() >= deadline)
      throw new DesktopUpdateError(
        "UPDATE_HANDOFF_TIMEOUT",
        "The installer lock could not be confirmed.",
      );
    await delay(100);
  }
  // The durable HANDOFF_STARTED record precedes the one-use explicit execution authorization.
  await store.atomicJson(`${pending.transactionId}.go`, { transactionId: pending.transactionId });
  child.stdout.destroy();
  child.unref();
  options.quit();
}

function installedAppGuid(): string {
  const digest = createHash("sha1")
    .update(Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex"))
    .update("com.caelush.desktop")
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
