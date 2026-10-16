import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkspaceId } from "@caelush/protocol";
import type { DesktopArchiveApi } from "../../preload/api-types.js";
import {
  AccountArchiveManager,
  type AccountArchiveClient,
  type AccountArchiveSnapshot,
} from "./account-archive-manager.js";
const initial: AccountArchiveSnapshot = {
  tab: "SESSIONS",
  sessionFilter: {},
  workspaceFilter: {},
  status: "LOADING",
};
/** The account renderer uses only the named IPC methods. Old UI responses are discarded per identity. */
export function useAccountArchives(
  api: DesktopArchiveApi,
  identityKey: string,
  options: { onMutation?: () => void; onParentWorkspaceRequired?: (id: WorkspaceId) => void } = {},
) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [owned, setOwned] = useState<{
    api: DesktopArchiveApi;
    identityKey: string;
    manager: AccountArchiveManager;
  } | null>(null);
  const manager =
    owned?.api === api && owned.identityKey === identityKey ? owned.manager : undefined;
  useEffect(() => {
    const client: AccountArchiveClient = {
      listArchivedSessions: (input = {}) => api.listSessions(input),
      listArchivedWorkspaces: (input = {}) => api.listWorkspaces(input),
      getArchiveState: (input) => api.getState(input),
      restoreSession: (id, input) =>
        api.restore({ target: { type: "SESSION", sessionId: id }, archiveId: input.archiveId }),
      restoreWorkspace: (id, input) =>
        api.restore({ target: { type: "WORKSPACE", workspaceId: id }, archiveId: input.archiveId }),
      previewArchiveDeletion: (input) => api.previewDeletion(input),
      permanentlyDeleteArchives: (input) => api.permanentlyDelete(input),
      getSessionTranscript: (id, query = {}) => api.readTranscript({ sessionId: id, query }),
    };
    const next = new AccountArchiveManager(client, {
      onMutation: () => callbacks.current.onMutation?.(),
      onParentWorkspaceRequired: (id) => callbacks.current.onParentWorkspaceRequired?.(id),
    });
    setOwned({ api, identityKey, manager: next });
    void next.refresh();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void next.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      next.dispose();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [api, identityKey]);
  const subscribe = useCallback(
    (listener: () => void) => manager?.subscribe(listener) ?? (() => undefined),
    [manager],
  );
  const getSnapshot = useCallback(() => manager?.getSnapshot() ?? initial, [manager]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { state, manager };
}
