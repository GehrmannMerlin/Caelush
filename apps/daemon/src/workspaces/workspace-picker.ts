import { execFile } from "node:child_process";
import type { WorkspaceDirectoryPickerResponse } from "@caelush/protocol";

export interface WorkspaceDirectoryPicker {
  pick(): Promise<WorkspaceDirectoryPickerResponse>;
}

export interface WorkspacePickerProcessOptions {
  readonly windowsHide: boolean;
  readonly maxBuffer: number;
  readonly timeoutMs: number;
}

export type WorkspacePickerProcess = (
  file: string,
  args: readonly string[],
  options: WorkspacePickerProcessOptions,
) => Promise<{ readonly stdout: string }>;

export interface WindowsWorkspaceDirectoryPickerOptions {
  /** Upper bound for one picker interaction; the dialog process is terminated when it elapses. */
  readonly timeoutMs?: number;
}

/**
 * A native folder dialog belongs to the *host* process, not to the browser. The daemon is a
 * background service, so a dialog shown without an owner window is created without foreground
 * rights: Windows draws it behind the browser (or not at all), the process blocks inside
 * `ShowDialog()` forever, and the pending HTTP request turns into an endless spinner.
 *
 * The picker therefore owns a small always-on-top window and shows the folder dialog as its modal
 * child. An owned dialog always stays above its owner, and a topmost owner is drawn above the
 * browser, so the dialog is guaranteed to surface even though the daemon never had foreground.
 *
 * The owner window is intentionally kept free of P/Invoke and `Add-Type -TypeDefinition`: compiling
 * C# at runtime is blocked by endpoint protection on some managed machines, and a silent
 * compilation failure used to degrade the picker into a process that could never appear or exit.
 */
const WINDOWS_PICKER_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
[System.Windows.Forms.Application]::EnableVisualStyles()

$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'Caelush'
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.ShowInTaskbar = $true
$owner.TopMost = $true
$owner.ControlBox = $false
$owner.MaximizeBox = $false
$owner.MinimizeBox = $false
$owner.ClientSize = New-Object System.Drawing.Size(420, 96)
$ownerLabel = New-Object System.Windows.Forms.Label
$ownerLabel.Text = '正在打开文件夹选择器…'
$ownerLabel.Dock = [System.Windows.Forms.DockStyle]::Fill
$ownerLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$owner.Controls.Add($ownerLabel)
$owner.Show()
$owner.Activate()

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a Caelush workspace folder'
$dialog.ShowNewFolderButton = $false
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
  $owner.Hide()
  $owner.Close()
  $owner.Dispose()
}
`.trim();

const WINDOWS_PICKER_ARGS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-STA",
  "-Command",
  WINDOWS_PICKER_SCRIPT,
]);

/**
 * Bounded so a picker that can never resolve cannot hold the HTTP request (or a stray process) forever.
 * Generous enough that browsing a slow network tree is never cut short.
 */
export const WORKSPACE_PICKER_TIMEOUT_MS = 300_000;

/** Raised when the native picker process outlived the interaction budget and was terminated. */
export class WorkspacePickerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Workspace picker exceeded ${timeoutMs}ms.`);
    this.name = "WorkspacePickerTimeoutError";
  }
}

export function createNativeWorkspaceDirectoryPicker(): WorkspaceDirectoryPicker {
  return process.platform === "win32"
    ? createWindowsWorkspaceDirectoryPicker()
    : unavailableWorkspaceDirectoryPicker();
}

export function createWindowsWorkspaceDirectoryPicker(
  run: WorkspacePickerProcess = executeWorkspacePickerProcess,
  options: WindowsWorkspaceDirectoryPickerOptions = {},
): WorkspaceDirectoryPicker {
  const timeoutMs = options.timeoutMs ?? WORKSPACE_PICKER_TIMEOUT_MS;
  return {
    async pick(): Promise<WorkspaceDirectoryPickerResponse> {
      try {
        const result = await run("powershell.exe", WINDOWS_PICKER_ARGS, {
          windowsHide: true,
          maxBuffer: 64 * 1024,
          timeoutMs,
        });
        const path = result.stdout.trim();
        return path.length === 0 ? { status: "CANCELLED" } : { status: "SELECTED", path };
      } catch (error) {
        return error instanceof WorkspacePickerTimeoutError
          ? { status: "TIMEOUT" }
          : { status: "UNAVAILABLE" };
      }
    },
  };
}

function unavailableWorkspaceDirectoryPicker(): WorkspaceDirectoryPicker {
  return {
    async pick(): Promise<WorkspaceDirectoryPickerResponse> {
      return { status: "UNAVAILABLE" };
    },
  };
}

function executeWorkspacePickerProcess(
  file: string,
  args: readonly string[],
  options: WorkspacePickerProcessOptions,
): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    let deadline: NodeJS.Timeout | undefined;
    const settle = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };
    const child = execFile(
      file,
      [...args],
      { ...options, encoding: "utf8" },
      (error, stdout) => {
        settle();
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
    deadline = setTimeout(() => {
      deadline = undefined;
      child.kill();
      reject(new WorkspacePickerTimeoutError(options.timeoutMs));
    }, options.timeoutMs);
    deadline.unref();
  });
}
