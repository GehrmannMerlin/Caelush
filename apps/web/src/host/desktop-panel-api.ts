export interface DesktopWorkspaceEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";
  readonly extension: string;
  readonly sizeBytes?: number;
  readonly modifiedAtMs?: number;
  readonly canExpand: boolean;
  readonly canPreview: boolean;
}

export interface DesktopWorkspaceDirectoryPage {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly parentPath: string | null;
  readonly items: readonly DesktopWorkspaceEntry[];
  readonly nextOffset?: number;
  readonly hasMore: boolean;
}

export type DesktopWorkspacePreview =
  | {
      readonly supported: true;
      readonly workspaceId: string;
      readonly relativePath: string;
      readonly name: string;
      readonly sizeBytes: number;
      readonly modifiedAtMs: number;
      readonly text: string;
    }
  | {
      readonly supported: false;
      readonly reason: "BINARY";
      readonly workspaceId: string;
      readonly relativePath: string;
      readonly name: string;
      readonly sizeBytes: number;
      readonly modifiedAtMs: number;
    };

export interface DesktopTerminalOutput {
  readonly terminalId: string;
  readonly data?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly errorCode?: "TERMINAL_OUTPUT_BACKPRESSURE" | "TERMINAL_UNAVAILABLE";
}

export interface DesktopTerminalSession {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly identity: "USER_TERMINAL";
  readonly shell: "WINDOWS_POWERSHELL";
  readonly cols: number;
  readonly rows: number;
}

export interface DesktopBrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopBrowserState {
  readonly leaseId: string;
  readonly url: string;
  readonly loading: boolean;
  readonly errorCode?: "BROWSER_NAVIGATION_FAILED" | "BROWSER_GUEST_CRASHED";
}

export interface DesktopEditorDescriptor {
  readonly id: "vscode" | "cursor";
  readonly name: "Visual Studio Code" | "Cursor";
}

export interface DesktopPanelApi {
  readonly workspace: {
    getAvailability(): Promise<
      { readonly available: true } | { readonly available: false; readonly reason: string }
    >;
    subscribeAvailability(listener: (available: boolean) => void): () => void;
    activate(input: { readonly workspaceId: string | null }): Promise<{ readonly selected: true }>;
    listEntries(input: {
      readonly workspaceId: string;
      readonly relativePath: string;
      readonly offset?: number;
      readonly limit?: number;
    }): Promise<DesktopWorkspaceDirectoryPage>;
    previewText(input: {
      readonly workspaceId: string;
      readonly relativePath: string;
    }): Promise<DesktopWorkspacePreview>;
    listEditors(input: {
      readonly workspaceId: string;
    }): Promise<readonly DesktopEditorDescriptor[]>;
    openInEditor(input: {
      readonly editorId: "vscode" | "cursor";
      readonly workspaceId: string;
      readonly relativeFilePath?: string;
    }): Promise<{ readonly opened: true; readonly editorId: "vscode" | "cursor" }>;
    readonly terminal: {
      create(input: {
        readonly workspaceId: string;
        readonly cols: number;
        readonly rows: number;
      }): Promise<DesktopTerminalSession>;
      write(input: {
        readonly terminalId: string;
        readonly data: string;
      }): Promise<{ readonly accepted: true }>;
      resize(input: {
        readonly terminalId: string;
        readonly cols: number;
        readonly rows: number;
      }): Promise<{ readonly accepted: true }>;
      close(input: { readonly terminalId: string }): Promise<{ readonly closed: true }>;
      subscribeOutput(
        terminalId: string,
        listener: (output: DesktopTerminalOutput) => void,
      ): Promise<() => void>;
      acknowledgeOutput(input: {
        readonly terminalId: string;
        readonly bytes: number;
      }): Promise<{ readonly acknowledged: true }>;
    };
  };
  readonly browser: {
    createLease(input: { readonly bounds: DesktopBrowserBounds }): Promise<DesktopBrowserState>;
    navigate(input: {
      readonly leaseId: string;
      readonly url: string;
    }): Promise<DesktopBrowserState>;
    goBack(input: { readonly leaseId: string }): Promise<DesktopBrowserState>;
    goForward(input: { readonly leaseId: string }): Promise<DesktopBrowserState>;
    reload(input: { readonly leaseId: string }): Promise<DesktopBrowserState>;
    setBounds(input: {
      readonly leaseId: string;
      readonly bounds: DesktopBrowserBounds | null;
    }): Promise<{ readonly updated: true }>;
    closeLease(input: { readonly leaseId: string }): Promise<{ readonly closed: true }>;
    subscribeState(listener: (state: DesktopBrowserState) => void): () => void;
  };
}

declare global {
  interface Window {
    readonly caelushDesktop?: DesktopPanelApi;
  }
}

export async function detectDesktopPanelApi(): Promise<DesktopPanelApi | null> {
  if (typeof window === "undefined" || window.caelushDesktop === undefined) return null;
  const api = window.caelushDesktop;
  try {
    const availability = await api.workspace.getAvailability();
    return availability.available ? api : null;
  } catch {
    // Main checks that this call came from the trusted Agent frame.
    return null;
  }
}
