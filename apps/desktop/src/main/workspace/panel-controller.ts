import type { BrowserWindow } from "electron";
import type { WorkspaceId } from "@caelush/protocol";
import {
  BrowserGuestManager,
  type BrowserGuestBounds,
  type BrowserGuestState,
} from "../browser/guest-manager.js";
import { DesktopEditorResolver, type DesktopEditorId } from "../ide/editor-resolver.js";
import type { DesktopDaemonSupervisor } from "../daemon/supervisor.js";
import type { DesktopDaemonProfileIdentity } from "../daemon/supervisor.js";
import type {
  DesktopTerminalOutput,
  DesktopTerminalSession,
} from "../terminal/user-terminal-manager.js";
import { DesktopUserTerminalManager } from "../terminal/user-terminal-manager.js";
import {
  DesktopWorkspaceError,
  DesktopWorkspaceFileService,
  type DesktopWorkspaceDirectoryPage,
  type DesktopWorkspaceTextPreview,
} from "./file-service.js";
import { resolveDesktopDaemonResources, type DesktopResourceLayout } from "../daemon/resources.js";

export interface DesktopWorkspacePanelControllerOptions {
  readonly window: BrowserWindow;
  readonly supervisor: DesktopDaemonSupervisor;
  readonly resourceLayout: DesktopResourceLayout;
  readonly onTerminalOutput: (ownerId: number, output: DesktopTerminalOutput) => void;
  readonly onBrowserState: (ownerId: number, state: BrowserGuestState) => void;
}

export class DesktopWorkspacePanelController {
  private readonly files: DesktopWorkspaceFileService;
  private readonly editors: DesktopEditorResolver;
  private readonly browser: BrowserGuestManager;
  private readonly activeWorkspaces = new Map<
    number,
    { readonly workspaceId: WorkspaceId; readonly identity: DesktopDaemonProfileIdentity }
  >();
  private terminalPromise: Promise<DesktopUserTerminalManager> | undefined;
  private terminalRuntime: DesktopUserTerminalManager | undefined;

  constructor(private readonly options: DesktopWorkspacePanelControllerOptions) {
    this.files = new DesktopWorkspaceFileService({
      acquireLease: (signal) => options.supervisor.acquireProxyLease(signal),
    });
    this.editors = new DesktopEditorResolver({ workspaceFiles: this.files });
    this.browser = new BrowserGuestManager({
      window: options.window,
      getCurrentIdentity: () => options.supervisor.getActiveProfileIdentity(),
      sendState: options.onBrowserState,
    });
  }

  getAvailability():
    | { readonly available: true }
    | { readonly available: false; readonly reason: "ACCOUNT_NOT_AUTHORIZED" | "DAEMON_STARTING" } {
    if (this.options.supervisor.getActiveProfileIdentity() !== null) return { available: true };
    return { available: false, reason: "ACCOUNT_NOT_AUTHORIZED" };
  }

  async activateWorkspace(
    ownerId: number,
    workspaceId: WorkspaceId | null,
    signal: AbortSignal,
  ): Promise<{ readonly selected: true }> {
    const identity = this.requireReady();
    const previous = this.activeWorkspaces.get(ownerId);
    if (
      previous !== undefined &&
      (workspaceId === null ||
        previous.workspaceId !== workspaceId ||
        !sameIdentity(previous.identity, identity))
    ) {
      this.activeWorkspaces.delete(ownerId);
      if (this.terminalPromise !== undefined) {
        await (await this.terminalPromise).clearWorkspace(ownerId);
      }
    }
    if (workspaceId === null) {
      this.activeWorkspaces.delete(ownerId);
      return { selected: true };
    }
    await this.files.authorizeWorkspace(workspaceId, signal);
    const currentIdentity = this.requireReady();
    if (!sameIdentity(identity, currentIdentity)) {
      throw new DesktopWorkspaceError(
        "ACCOUNT_NOT_AUTHORIZED",
        "The Desktop Profile changed while the Workspace was selected.",
      );
    }
    this.activeWorkspaces.set(ownerId, { workspaceId, identity });
    await (await this.terminals()).activateWorkspace(ownerId, workspaceId);
    if (!sameIdentity(identity, this.requireReady())) {
      this.activeWorkspaces.delete(ownerId);
      throw new DesktopWorkspaceError(
        "ACCOUNT_NOT_AUTHORIZED",
        "The Desktop Profile changed while the Workspace was selected.",
      );
    }
    return { selected: true };
  }

  async listEntries(
    ownerId: number,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly relativePath: string;
      readonly offset: number;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<DesktopWorkspaceDirectoryPage> {
    this.requireSelectedWorkspace(ownerId, input.workspaceId);
    return this.files.listEntries(input, signal);
  }

  async previewText(
    ownerId: number,
    input: { readonly workspaceId: WorkspaceId; readonly relativePath: string },
    signal: AbortSignal,
  ): Promise<DesktopWorkspaceTextPreview> {
    this.requireSelectedWorkspace(ownerId, input.workspaceId);
    return this.files.previewText(input, signal);
  }

  async listEditors(ownerId: number, workspaceId: WorkspaceId, signal: AbortSignal) {
    this.requireSelectedWorkspace(ownerId, workspaceId);
    await this.files.authorizeWorkspace(workspaceId, signal);
    const editors = await this.editors.listEditors();
    this.requireSelectedWorkspace(ownerId, workspaceId);
    return editors;
  }

  async openInEditor(
    ownerId: number,
    input: {
      readonly editorId: DesktopEditorId;
      readonly workspaceId: WorkspaceId;
      readonly relativeFilePath?: string;
    },
    signal: AbortSignal,
  ) {
    this.requireSelectedWorkspace(ownerId, input.workspaceId);
    return this.editors.openInEditor(
      {
        editorId: input.editorId,
        workspaceId: input.workspaceId,
        ...(input.relativeFilePath === undefined
          ? {}
          : { relativeFilePath: input.relativeFilePath }),
      },
      signal,
    );
  }

  async createTerminal(
    ownerId: number,
    input: { readonly workspaceId: WorkspaceId; readonly cols: number; readonly rows: number },
    signal: AbortSignal,
  ): Promise<DesktopTerminalSession> {
    this.requireSelectedWorkspace(ownerId, input.workspaceId);
    return (await this.terminals()).create({ ...input, ownerId, signal });
  }

  writeTerminal(ownerId: number, terminalId: string, data: string): { readonly accepted: true } {
    this.requireActive();
    this.terminalManager().write(ownerId, terminalId, data);
    return { accepted: true };
  }

  resizeTerminal(
    ownerId: number,
    terminalId: string,
    cols: number,
    rows: number,
  ): { readonly accepted: true } {
    this.requireActive();
    this.terminalManager().resize(ownerId, terminalId, { cols, rows });
    return { accepted: true };
  }

  subscribeTerminal(ownerId: number, terminalId: string): { readonly subscribed: true } {
    this.requireActive();
    this.terminalManager().subscribeOutput(ownerId, terminalId);
    return { subscribed: true };
  }

  unsubscribeTerminal(ownerId: number, terminalId: string): { readonly subscribed: false } {
    this.terminalManager().unsubscribeOutput(ownerId, terminalId);
    return { subscribed: false };
  }

  acknowledgeTerminal(
    ownerId: number,
    terminalId: string,
    bytes: number,
  ): { readonly acknowledged: true } {
    this.terminalManager().acknowledgeOutput(ownerId, terminalId, bytes);
    return { acknowledged: true };
  }

  closeTerminal(ownerId: number, terminalId: string): Promise<{ readonly closed: true }> {
    return this.terminalManager()
      .close(ownerId, terminalId)
      .then(() => ({ closed: true as const }));
  }

  createBrowserLease(ownerId: number, bounds: BrowserGuestBounds): Promise<BrowserGuestState> {
    this.requireReady();
    return this.browser.createLease(ownerId, bounds);
  }

  navigateBrowser(
    ownerId: number,
    leaseId: string,
    url: string,
    signal: AbortSignal,
  ): Promise<BrowserGuestState> {
    this.requireReady();
    return this.browser.navigate(ownerId, leaseId, url, signal);
  }

  goBackBrowser(ownerId: number, leaseId: string): BrowserGuestState {
    this.requireReady();
    return this.browser.goBack(ownerId, leaseId);
  }

  goForwardBrowser(ownerId: number, leaseId: string): BrowserGuestState {
    this.requireReady();
    return this.browser.goForward(ownerId, leaseId);
  }

  reloadBrowser(ownerId: number, leaseId: string): BrowserGuestState {
    this.requireReady();
    return this.browser.reload(ownerId, leaseId);
  }

  setBrowserBounds(
    ownerId: number,
    leaseId: string,
    bounds: BrowserGuestBounds | null,
  ): { readonly updated: true } {
    this.requireReady();
    this.browser.setBounds(ownerId, leaseId, bounds);
    return { updated: true };
  }

  closeBrowserLease(ownerId: number, leaseId: string): Promise<{ readonly closed: true }> {
    return this.browser.closeLease(ownerId, leaseId).then(() => ({ closed: true as const }));
  }

  async closeAll(): Promise<void> {
    const outcomes = await Promise.allSettled([
      this.terminalPromise?.then((manager) => manager.closeAll()) ?? Promise.resolve(),
      this.browser.closeAll(),
    ]);
    this.activeWorkspaces.clear();
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  dispose(): void {
    this.browser.dispose();
    this.activeWorkspaces.clear();
    if (this.terminalPromise !== undefined) {
      void this.terminalPromise.then((manager) => manager.closeAll()).catch(() => undefined);
    }
  }

  private terminalManager(): DesktopUserTerminalManager {
    if (this.terminalRuntime === undefined)
      throw new Error("The user terminal runtime is unavailable.");
    return this.terminalRuntime;
  }

  private async terminals(): Promise<DesktopUserTerminalManager> {
    if (this.terminalPromise === undefined) {
      this.terminalPromise = resolveDesktopDaemonResources(this.options.resourceLayout).then(
        (resources) => {
          const manager = new DesktopUserTerminalManager({
            authorizeWorkspace: (workspaceId, signal) =>
              this.files.authorizeWorkspace(workspaceId, signal),
            nodeExecutablePath: resources.nodeExecutablePath,
            helperPath: resources.userTerminalHelperPath,
            isCurrentIdentity: (identity) =>
              this.options.supervisor.isActiveProfileIdentity(identity),
            sendOutput: this.options.onTerminalOutput,
            environment: process.env,
          });
          this.terminalRuntime = manager;
          return manager;
        },
      );
    }
    return this.terminalPromise;
  }

  private requireSelectedWorkspace(ownerId: number, workspaceId: WorkspaceId): void {
    const identity = this.requireReady();
    const active = this.activeWorkspaces.get(ownerId);
    if (
      active === undefined ||
      active.workspaceId !== workspaceId ||
      !sameIdentity(active.identity, identity)
    ) {
      this.activeWorkspaces.delete(ownerId);
      throw new DesktopWorkspaceError(
        "ACCOUNT_NOT_AUTHORIZED",
        "Select this registered Workspace in the Desktop first.",
      );
    }
  }

  private requireReady(): DesktopDaemonProfileIdentity {
    const identity = this.options.supervisor.getActiveProfileIdentity();
    if (identity === null) {
      throw new DesktopWorkspaceError(
        "ACCOUNT_NOT_AUTHORIZED",
        "The authorized Desktop Profile is no longer active.",
      );
    }
    return identity;
  }

  private requireActive(): void {
    this.requireReady();
  }
}

function sameIdentity(
  left: Pick<DesktopDaemonProfileIdentity, "userId" | "profileId" | "generationId">,
  right: Pick<DesktopDaemonProfileIdentity, "userId" | "profileId" | "generationId">,
): boolean {
  return (
    left.userId === right.userId &&
    left.profileId === right.profileId &&
    left.generationId === right.generationId
  );
}
