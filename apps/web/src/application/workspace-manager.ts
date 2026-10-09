import { CaelushClientHttpError } from "@caelush/client";
import {
  WorkspaceIdSchema,
  type CreateWorkspaceRequest,
  type WorkspaceId,
  type WorkspaceDirectoryPickerResponse,
  type WorkspaceRecord,
  type WorkspaceSessionSummary,
} from "@caelush/protocol";

export interface WorkspaceSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StorageLike = WorkspaceSelectionStorage | Map<string, string>;

const SELECTED_WORKSPACE_KEY = "caelush:selected-workspace";

/** Persists only the selected registry id. Workspace paths never come from browser storage. */
export class WorkspaceSelectionStore {
  constructor(private readonly storage: StorageLike = browserStorage()) {}

  read(): WorkspaceId | undefined {
    const raw = get(this.storage, SELECTED_WORKSPACE_KEY);
    if (raw === null) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.clear();
      return undefined;
    }
    const parsed = WorkspaceIdSchema.safeParse(value);
    if (!parsed.success) {
      this.clear();
      return undefined;
    }
    return parsed.data;
  }

  write(workspaceId: WorkspaceId): void {
    const parsed = WorkspaceIdSchema.safeParse(workspaceId);
    if (!parsed.success) {
      this.clear();
      return;
    }
    set(this.storage, SELECTED_WORKSPACE_KEY, JSON.stringify(parsed.data));
  }

  clear(): void {
    remove(this.storage, SELECTED_WORKSPACE_KEY);
  }
}

export interface WorkspaceManagerClient {
  listWorkspaces(): Promise<{ readonly items: readonly WorkspaceRecord[] }>;
  createWorkspace(input: CreateWorkspaceRequest): Promise<WorkspaceRecord>;
  deleteWorkspace(workspaceId: WorkspaceId): Promise<void>;
  pickWorkspaceDirectory?(): Promise<WorkspaceDirectoryPickerResponse>;
  listWorkspaceSessions(workspaceId: WorkspaceId): Promise<{
    readonly items: readonly WorkspaceSessionSummary[];
  }>;
}

export type WorkspaceManagerLoadState = "IDLE" | "LOADING" | "READY" | "ERROR";

export interface WorkspaceManagerError {
  readonly code:
    | "WORKSPACE_LOAD_FAILED"
    | "WORKSPACE_REGISTER_FAILED"
    | "WORKSPACE_FORGET_FAILED"
    | "ACTIVE_RUN_CONFLICT";
  readonly message: string;
}

export interface WorkspaceManagerState {
  readonly status: WorkspaceManagerLoadState;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId?: WorkspaceId | undefined;
  readonly expandedWorkspaceIds: readonly WorkspaceId[];
  readonly sessionSummaries: Readonly<Record<string, readonly WorkspaceSessionSummary[]>>;
  readonly error?: WorkspaceManagerError | undefined;
}

export type WorkspaceManagerListener = (state: WorkspaceManagerState) => void;

export class WebWorkspaceManager {
  private readonly listeners = new Set<WorkspaceManagerListener>();
  private snapshot: WorkspaceManagerState = initialState();
  private disposed = false;

  constructor(
    private readonly options: {
      readonly client: WorkspaceManagerClient;
      readonly selectionStore?: WorkspaceSelectionStore;
      readonly initialWorkspaceId?: WorkspaceId | undefined;
    },
  ) {}

  getSnapshot(): WorkspaceManagerState {
    return this.snapshot;
  }

  subscribe(listener: WorkspaceManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadWorkspaces(): Promise<void> {
    if (this.disposed) return;
    this.publish({ status: "LOADING", error: undefined });
    try {
      const response = await this.options.client.listWorkspaces();
      const workspaces = [...response.items];
      const selectedWorkspaceId = this.chooseWorkspace(workspaces);
      const availableWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
      const expandedWorkspaceIds = this.snapshot.expandedWorkspaceIds.filter((workspaceId) =>
        availableWorkspaceIds.has(workspaceId),
      );
      if (
        selectedWorkspaceId !== undefined &&
        !expandedWorkspaceIds.includes(selectedWorkspaceId)
      ) {
        expandedWorkspaceIds.push(selectedWorkspaceId);
      }
      this.publish({
        status: "READY",
        workspaces,
        selectedWorkspaceId,
        expandedWorkspaceIds,
        error: undefined,
      });
      if (selectedWorkspaceId !== undefined) {
        this.persistSelection(selectedWorkspaceId);
        await this.loadWorkspaceSessions(selectedWorkspaceId);
      }
    } catch (error) {
      this.publish({
        status: "ERROR",
        error: workspaceError("WORKSPACE_LOAD_FAILED", error),
      });
    }
  }

  async selectWorkspace(workspaceId: WorkspaceId): Promise<boolean> {
    if (this.disposed) return false;
    const workspace = this.snapshot.workspaces.find((item) => item.id === workspaceId);
    if (workspace === undefined) return false;
    this.persistSelection(workspace.id);
    const expandedWorkspaceIds = this.snapshot.expandedWorkspaceIds.includes(workspace.id)
      ? this.snapshot.expandedWorkspaceIds
      : [...this.snapshot.expandedWorkspaceIds, workspace.id];
    this.publish({
      selectedWorkspaceId: workspace.id,
      expandedWorkspaceIds,
      error: undefined,
    });
    await this.loadWorkspaceSessions(workspace.id);
    return !this.disposed;
  }

  async loadWorkspaceSessions(workspaceId: WorkspaceId): Promise<void> {
    if (this.disposed) return;
    try {
      const response = await this.options.client.listWorkspaceSessions(workspaceId);
      this.publish({
        sessionSummaries: {
          ...this.snapshot.sessionSummaries,
          [workspaceId]: [...response.items],
        },
        error: undefined,
      });
    } catch (error) {
      this.publish({
        error: workspaceError("WORKSPACE_LOAD_FAILED", error),
      });
    }
  }

  async registerWorkspace(path: string, displayName?: string): Promise<WorkspaceRecord> {
    if (this.disposed) throw new Error("Workspace manager is disposed.");
    try {
      const input: CreateWorkspaceRequest = displayName?.trim()
        ? { path, displayName: displayName.trim() }
        : { path };
      const created = await this.options.client.createWorkspace(input);
      await this.loadWorkspaces();
      if (!this.snapshot.workspaces.some((item) => item.id === created.id)) {
        this.publish({ workspaces: [...this.snapshot.workspaces, created] });
      }
      await this.selectWorkspace(created.id);
      return created;
    } catch (error) {
      const mapped = workspaceError("WORKSPACE_REGISTER_FAILED", error);
      this.publish({ status: "ERROR", error: mapped });
      throw error;
    }
  }

  async pickWorkspaceDirectory(): Promise<WorkspaceDirectoryPickerResponse> {
    if (this.disposed || this.options.client.pickWorkspaceDirectory === undefined) {
      return { status: "UNAVAILABLE" };
    }
    return this.options.client.pickWorkspaceDirectory();
  }

  async forgetWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (this.disposed) return;
    try {
      await this.options.client.deleteWorkspace(workspaceId);
      if (this.options.selectionStore?.read() === workspaceId) this.options.selectionStore.clear();
      const sessionSummaries = { ...this.snapshot.sessionSummaries };
      delete sessionSummaries[workspaceId];
      this.publish({ sessionSummaries, error: undefined });
      await this.loadWorkspaces();
    } catch (error) {
      const mapped = workspaceError("WORKSPACE_FORGET_FAILED", error);
      this.publish({
        status: mapped.code === "ACTIVE_RUN_CONFLICT" ? "READY" : "ERROR",
        error: mapped,
      });
      throw error;
    }
  }

  toggleWorkspaceExpanded(workspaceId: WorkspaceId): void {
    if (this.disposed || !this.snapshot.workspaces.some((item) => item.id === workspaceId)) return;
    const expanded = this.snapshot.expandedWorkspaceIds.includes(workspaceId)
      ? this.snapshot.expandedWorkspaceIds.filter((id) => id !== workspaceId)
      : [...this.snapshot.expandedWorkspaceIds, workspaceId];
    this.publish({ expandedWorkspaceIds: expanded });
    if (
      expanded.includes(workspaceId) &&
      this.snapshot.sessionSummaries[workspaceId] === undefined
    ) {
      void this.loadWorkspaceSessions(workspaceId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private chooseWorkspace(workspaces: readonly WorkspaceRecord[]): WorkspaceId | undefined {
    const available = new Set(workspaces.map((workspace) => workspace.id));
    const persisted = this.options.selectionStore?.read();
    if (persisted !== undefined && available.has(persisted)) return persisted;
    if (
      this.options.initialWorkspaceId !== undefined &&
      available.has(this.options.initialWorkspaceId)
    ) {
      return this.options.initialWorkspaceId;
    }
    if (
      this.snapshot.selectedWorkspaceId !== undefined &&
      available.has(this.snapshot.selectedWorkspaceId)
    ) {
      return this.snapshot.selectedWorkspaceId;
    }
    return workspaces[0]?.id;
  }

  private persistSelection(workspaceId: WorkspaceId): void {
    this.options.selectionStore?.write(workspaceId);
  }

  private publish(patch: Partial<WorkspaceManagerState>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function initialState(): WorkspaceManagerState {
  return {
    status: "IDLE",
    workspaces: [],
    expandedWorkspaceIds: [],
    sessionSummaries: {},
  };
}

function workspaceError(
  fallback: Exclude<WorkspaceManagerError["code"], "ACTIVE_RUN_CONFLICT">,
  error: unknown,
): WorkspaceManagerError {
  if (error instanceof CaelushClientHttpError && error.code === "ACTIVE_RUN_CONFLICT") {
    return {
      code: "ACTIVE_RUN_CONFLICT",
      message: "该工作区仍有运行中的任务，暂时无法移除。",
    };
  }
  const message = error instanceof Error ? error.message : "工作区操作失败。";
  return { code: fallback, message: message || "工作区操作失败。" };
}

function browserStorage(): WorkspaceSelectionStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function get(storage: StorageLike, key: string): string | null {
  return storage instanceof Map ? (storage.get(key) ?? null) : storage.getItem(key);
}

function set(storage: StorageLike, key: string, value: string): void {
  if (storage instanceof Map) storage.set(key, value);
  else storage.setItem(key, value);
}

function remove(storage: StorageLike, key: string): void {
  if (storage instanceof Map) storage.delete(key);
  else storage.removeItem(key);
}
