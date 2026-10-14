import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { WorkspaceId, WorkspaceRecord } from "@caelush/protocol";
import { Check, ChevronDown, Folder, Plus, Search } from "lucide-react";

export interface WorkspacePickerProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId?: WorkspaceId | undefined;
  readonly fallbackWorkspaceName?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onAddWorkspace: () => void;
  readonly onSelectWorkspace: (workspaceId: WorkspaceId) => void;
}

export function WorkspacePicker(props: WorkspacePickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const hasWorkspaces = props.workspaces.length > 0;
  const selectedWorkspace = props.workspaces.find(
    (workspace) => workspace.id === props.selectedWorkspaceId,
  );
  const label =
    selectedWorkspace?.displayName ??
    props.fallbackWorkspaceName ??
    (hasWorkspaces ? "选择工作区" : "添加工作区");
  const filteredWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return props.workspaces;
    return props.workspaces.filter((workspace) =>
      `${workspace.displayName} ${workspace.canonicalPath}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [props.workspaces, query]);
  const closePicker = useCallback((): void => {
    setOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    searchRef.current?.focus();
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) closePicker();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePicker();
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePicker, open]);

  const handleTriggerClick = (): void => {
    if (props.disabled === true) return;
    if (!hasWorkspaces) {
      props.onAddWorkspace();
      return;
    }
    setOpen((current) => !current);
  };

  const handleAddWorkspace = (): void => {
    closePicker();
    props.onAddWorkspace();
  };

  const handleSelectWorkspace = (workspaceId: WorkspaceId): void => {
    closePicker();
    if (workspaceId !== props.selectedWorkspaceId) props.onSelectWorkspace(workspaceId);
  };

  return createElement(
    "div",
    { className: "workspace-switcher", ref: rootRef },
    createElement(
      "button",
      {
        type: "button",
        className: "conversation-workspace-control",
        ref: triggerRef,
        onClick: handleTriggerClick,
        disabled: props.disabled === true,
        "aria-label": hasWorkspaces ? `切换工作区，当前：${label}` : "添加工作区",
        "aria-haspopup": "dialog",
        "aria-expanded": hasWorkspaces && open,
        title: hasWorkspaces ? `当前工作区：${label}` : "添加工作区",
      },
      createElement(hasWorkspaces ? Folder : Plus, {
        size: 15,
        strokeWidth: 2.1,
        "aria-hidden": true,
      }),
      createElement("span", null, label),
      hasWorkspaces
        ? createElement(ChevronDown, {
            className: "workspace-switcher-chevron",
            size: 13,
            strokeWidth: 2,
            "aria-hidden": true,
          })
        : null,
    ),
    hasWorkspaces && open
      ? createElement(
          "div",
          {
            className: "workspace-switcher-popover",
            role: "dialog",
            "aria-label": "切换工作区",
          },
          createElement(
            "label",
            { className: "workspace-switcher-search" },
            createElement(Search, { size: 15, strokeWidth: 2, "aria-hidden": true }),
            createElement("input", {
              ref: searchRef,
              type: "search",
              value: query,
              onChange: (event: { currentTarget: HTMLInputElement }) =>
                setQuery(event.currentTarget.value),
              placeholder: "搜索项目",
              "aria-label": "搜索工作区",
              autoComplete: "off",
              spellCheck: false,
            }),
          ),
          createElement(
            "div",
            { className: "workspace-switcher-list", role: "listbox", "aria-label": "工作区" },
            filteredWorkspaces.length === 0
              ? createElement("p", { className: "workspace-switcher-empty" }, "没有匹配的工作区")
              : filteredWorkspaces.map((workspace) => {
                  const selected = workspace.id === props.selectedWorkspaceId;
                  return createElement(
                    "button",
                    {
                      type: "button",
                      className: `workspace-switcher-option${selected ? " is-selected" : ""}`,
                      key: workspace.id,
                      role: "option",
                      "aria-selected": selected,
                      title: workspace.canonicalPath,
                      onClick: () => handleSelectWorkspace(workspace.id),
                    },
                    createElement(Folder, {
                      size: 15,
                      strokeWidth: 1.9,
                      "aria-hidden": true,
                    }),
                    createElement("span", null, workspace.displayName),
                    selected
                      ? createElement(Check, {
                          className: "workspace-switcher-check",
                          size: 15,
                          strokeWidth: 2.2,
                          "aria-hidden": true,
                        })
                      : null,
                  );
                }),
          ),
          createElement(
            "div",
            { className: "workspace-switcher-footer" },
            createElement(
              "button",
              {
                type: "button",
                className: "workspace-switcher-add",
                onClick: handleAddWorkspace,
              },
              createElement(Plus, { size: 15, strokeWidth: 2.1, "aria-hidden": true }),
              createElement("span", null, "添加工作区"),
            ),
          ),
        )
      : null,
  );
}
