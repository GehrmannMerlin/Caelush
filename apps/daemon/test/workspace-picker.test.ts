import { describe, expect, it } from "vitest";
import {
  createWindowsWorkspaceDirectoryPicker,
  WorkspacePickerTimeoutError,
  type WorkspacePickerProcess,
  type WorkspacePickerProcessOptions,
} from "../src/workspaces/workspace-picker.js";

describe("Windows workspace directory picker", () => {
  it("maps PowerShell output to a selected directory", async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: WorkspacePickerProcessOptions;
    }> = [];
    const run: WorkspacePickerProcess = async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "D:\\Develop\\Caelush\r\n" };
    };

    await expect(createWindowsWorkspaceDirectoryPicker(run).pick()).resolves.toEqual({
      status: "SELECTED",
      path: "D:\\Develop\\Caelush",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: "powershell.exe" });
    expect(calls[0]?.args).toContain("-STA");
    expect(calls[0]?.options.windowsHide).toBe(true);
    expect(calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it("owns the native dialog with a topmost window so a background daemon can still surface it", async () => {
    let command = "";
    let options: WorkspacePickerProcessOptions | undefined;
    const run: WorkspacePickerProcess = async (_file, args, received) => {
      command = String(args[args.indexOf("-Command") + 1]);
      options = received;
      return { stdout: "\r\n" };
    };

    await createWindowsWorkspaceDirectoryPicker(run).pick();

    expect(command).toContain("$owner.TopMost = $true");
    expect(command).toContain("$owner.Show()");
    expect(command).toContain("$dialog.ShowDialog($owner)");
    // Compiling C# at runtime is blocked by endpoint protection on managed machines and used to
    // leave a picker process that could neither appear nor exit.
    expect(command).not.toContain("Add-Type -TypeDefinition");
    expect(command).not.toContain("user32.dll");
    expect(options?.timeoutMs).toBeGreaterThan(0);
  });

  it("applies the configured interaction budget", async () => {
    let options: WorkspacePickerProcessOptions | undefined;
    const run: WorkspacePickerProcess = async (_file, _args, received) => {
      options = received;
      return { stdout: "D:\\work\r\n" };
    };

    await createWindowsWorkspaceDirectoryPicker(run, { timeoutMs: 1234 }).pick();

    expect(options?.timeoutMs).toBe(1234);
  });

  it("treats an empty native dialog result as cancellation", async () => {
    const run: WorkspacePickerProcess = async () => ({ stdout: "\r\n" });

    await expect(createWindowsWorkspaceDirectoryPicker(run).pick()).resolves.toEqual({
      status: "CANCELLED",
    });
  });

  it("fails closed when the native picker process cannot start", async () => {
    const run: WorkspacePickerProcess = async () => {
      throw new Error("powershell unavailable");
    };

    await expect(createWindowsWorkspaceDirectoryPicker(run).pick()).resolves.toEqual({
      status: "UNAVAILABLE",
    });
  });

  it("reports a terminated picker as a timeout instead of an unavailable host", async () => {
    const run: WorkspacePickerProcess = async () => {
      throw new WorkspacePickerTimeoutError(1234);
    };

    await expect(createWindowsWorkspaceDirectoryPicker(run).pick()).resolves.toEqual({
      status: "TIMEOUT",
    });
  });
});
