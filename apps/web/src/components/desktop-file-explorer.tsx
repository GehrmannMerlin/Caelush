import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  ArrowUp,
  ExternalLink,
} from "lucide-react";
import type {
  DesktopPanelApi,
  DesktopWorkspaceDirectoryPage,
  DesktopWorkspaceEntry,
} from "../host/desktop-panel-api.js";

export function DesktopFileExplorer(props: {
  readonly api: DesktopPanelApi;
  readonly workspaceId: string | null;
}): ReactElement {
  const [directories, setDirectories] = useState<Record<string, DesktopWorkspaceDirectoryPage>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<DesktopPanelApi["workspace"]["previewText"]>
  > | null>(null);
  const [editors, setEditors] = useState<
    Awaited<ReturnType<DesktopPanelApi["workspace"]["listEditors"]>>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceRef = useRef(props.workspaceId);
  const directoriesRef = useRef(directories);
  workspaceRef.current = props.workspaceId;
  directoriesRef.current = directories;

  const loadDirectory = useCallback(
    async (relativePath: string, append = false) => {
      const workspaceId = props.workspaceId;
      if (workspaceId === null) return;
      setBusy(true);
      setError(null);
      const current = directoriesRef.current[relativePath];
      const offset = append ? (current?.nextOffset ?? current?.items.length ?? 0) : 0;
      try {
        const result = await props.api.workspace.listEntries({
          workspaceId,
          relativePath,
          offset,
          limit: 200,
        });
        if (workspaceRef.current !== workspaceId) return;
        setDirectories((previous) => ({
          ...previous,
          [relativePath]:
            append && previous[relativePath] !== undefined
              ? { ...result, items: [...previous[relativePath]!.items, ...result.items] }
              : result,
        }));
      } catch (loadError) {
        if (workspaceRef.current === workspaceId) setError(toMessage(loadError, "目录读取失败。"));
      } finally {
        if (workspaceRef.current === workspaceId) setBusy(false);
      }
    },
    [props.api, props.workspaceId],
  );

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set());
    setCurrentPath("");
    setSelectedFile(null);
    setPreview(null);
    setEditors([]);
    setError(null);
    if (props.workspaceId === null) return;
    void loadDirectory("");
    void props.api.workspace
      .listEditors({ workspaceId: props.workspaceId })
      .then((next) => {
        if (workspaceRef.current === props.workspaceId) setEditors(next);
      })
      .catch(() => {
        if (workspaceRef.current === props.workspaceId) setEditors([]);
      });
  }, [loadDirectory, props.api, props.workspaceId]);

  const openFile = useCallback(
    async (entry: DesktopWorkspaceEntry) => {
      if (props.workspaceId === null || !entry.canPreview) return;
      setSelectedFile(entry.relativePath);
      setPreview(null);
      setError(null);
      try {
        const result = await props.api.workspace.previewText({
          workspaceId: props.workspaceId,
          relativePath: entry.relativePath,
        });
        if (workspaceRef.current === props.workspaceId) setPreview(result);
      } catch (loadError) {
        if (workspaceRef.current === props.workspaceId)
          setError(toMessage(loadError, "文件预览失败。"));
      }
    },
    [props.api, props.workspaceId],
  );

  const openEditor = useCallback(
    async (editorId: "vscode" | "cursor", relativeFilePath?: string) => {
      if (props.workspaceId === null) return;
      setError(null);
      try {
        await props.api.workspace.openInEditor({
          editorId,
          workspaceId: props.workspaceId,
          ...(relativeFilePath === undefined ? {} : { relativeFilePath }),
        });
      } catch (openError) {
        setError(toMessage(openError, "无法在所选编辑器中打开工作区。"));
      }
    },
    [props.api, props.workspaceId],
  );

  const paths = useMemo(() => (currentPath === "" ? [] : currentPath.split("/")), [currentPath]);
  const rootPage = directories[""];

  if (props.workspaceId === null) {
    return createElement(
      "div",
      { className: "desktop-panel-empty", role: "status" },
      createElement("strong", null, "未选择工作区"),
      createElement("span", null, "选择一个工作区后即可浏览文件。"),
    );
  }

  return createElement(
    "section",
    { className: "desktop-files", "aria-label": "工作区文件" },
    createElement(
      "div",
      { className: "desktop-files-toolbar" },
      createElement(
        "button",
        {
          type: "button",
          className: "desktop-icon-button",
          disabled: currentPath === "" || busy,
          onClick: () => {
            const parent = currentPath.split("/").slice(0, -1).join("/");
            setCurrentPath(parent);
            void loadDirectory(parent);
          },
          title: "返回上级目录",
          "aria-label": "返回上级目录",
        },
        createElement(ArrowUp, { size: 15 }),
      ),
      createElement(
        "div",
        { className: "desktop-path-breadcrumb", title: currentPath || "工作区根目录" },
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              setCurrentPath("");
              void loadDirectory("");
            },
          },
          "工作区",
        ),
        ...paths.map((part, index) =>
          createElement("span", { key: `${index}-${part}` }, " / ", part),
        ),
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "desktop-icon-button",
          disabled: busy,
          onClick: () => void loadDirectory(currentPath),
          title: "刷新目录",
          "aria-label": "刷新目录",
        },
        createElement(RefreshCw, { size: 15 }),
      ),
      createElement(
        "div",
        { className: "desktop-editor-actions" },
        editors.length === 0
          ? createElement(
              "span",
              { className: "desktop-editor-unavailable", role: "status" },
              "未检测到 IDE",
            )
          : editors.map((editor) =>
              createElement(
                "button",
                {
                  key: editor.id,
                  type: "button",
                  className: "desktop-editor-button",
                  onClick: () => void openEditor(editor.id),
                  title: `在 ${editor.name} 中打开工作区`,
                },
                createElement(ExternalLink, { size: 13 }),
                editor.id === "vscode" ? "VS Code" : "Cursor",
              ),
            ),
      ),
    ),
    error === null
      ? null
      : createElement("p", { className: "desktop-panel-error", role: "alert" }, error),
    createElement(
      "div",
      { className: "desktop-files-content" },
      createElement(
        "div",
        { className: "desktop-file-tree", role: "tree", "aria-label": "文件和文件夹" },
        rootPage === undefined
          ? createElement(
              "p",
              { className: "desktop-panel-hint" },
              busy ? "正在读取目录…" : "目录为空或无法读取。",
            )
          : renderTree("", 0),
        rootPage?.hasMore
          ? createElement(
              "button",
              {
                type: "button",
                className: "desktop-load-more",
                disabled: busy,
                onClick: () => void loadDirectory("", true),
              },
              "加载更多",
            )
          : null,
      ),
      createElement(
        "div",
        { className: "desktop-file-preview" },
        selectedFile === null
          ? createElement("p", { className: "desktop-panel-hint" }, "选择文本文件以预览内容。")
          : preview === null
            ? createElement("p", { className: "desktop-panel-hint" }, "正在读取预览…")
            : preview.supported
              ? createElement(
                  "pre",
                  { className: "desktop-preview-code", "aria-label": `${preview.name} 文件预览` },
                  preview.text,
                )
              : createElement(
                  "p",
                  { className: "desktop-panel-hint", role: "status" },
                  "此二进制文件不支持文本预览。",
                ),
      ),
    ),
  );

  function renderTree(relativePath: string, depth: number): ReactElement {
    const page = directories[relativePath];
    if (page === undefined)
      return createElement("span", { className: "desktop-panel-hint" }, "正在读取…");
    return createElement(
      "div",
      { className: "desktop-tree-level", role: "group" },
      ...page.items.map((entry) => {
        if (entry.kind === "DIRECTORY") {
          const isOpen = expanded.has(entry.relativePath);
          return createElement(
            "div",
            { key: entry.relativePath, className: "desktop-tree-node" },
            createElement(
              "button",
              {
                type: "button",
                className: "desktop-tree-row",
                role: "treeitem",
                "aria-expanded": isOpen,
                style: { paddingLeft: `${8 + depth * 14}px` },
                onClick: () => {
                  setCurrentPath(entry.relativePath);
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(entry.relativePath)) next.delete(entry.relativePath);
                    else {
                      next.add(entry.relativePath);
                      if (directories[entry.relativePath] === undefined)
                        void loadDirectory(entry.relativePath);
                    }
                    return next;
                  });
                },
              },
              createElement(isOpen ? ChevronDown : ChevronRight, { size: 14 }),
              createElement(isOpen ? FolderOpen : Folder, { size: 15 }),
              createElement("span", { className: "desktop-tree-name" }, entry.name),
            ),
            isOpen ? renderTree(entry.relativePath, depth + 1) : null,
          );
        }
        return createElement(
          "button",
          {
            key: entry.relativePath,
            type: "button",
            role: "treeitem",
            className: `desktop-tree-row desktop-tree-row--file${selectedFile === entry.relativePath ? " is-selected" : ""}`,
            style: { paddingLeft: `${25 + depth * 14}px` },
            disabled: !entry.canPreview,
            onClick: () => void openFile(entry),
            title: `${entry.name}${entry.sizeBytes === undefined ? "" : ` · ${formatSize(entry.sizeBytes)}`}`,
          },
          createElement(File, { size: 14 }),
          createElement("span", { className: "desktop-tree-name" }, entry.name),
          entry.extension === ""
            ? null
            : createElement("span", { className: "desktop-file-type" }, entry.extension.slice(1)),
        );
      }),
      page.hasMore
        ? createElement(
            "button",
            {
              type: "button",
              className: "desktop-load-more",
              onClick: () => void loadDirectory(relativePath, true),
            },
            "加载更多",
          )
        : null,
    );
  }
}

function formatSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 240)
    : fallback;
}
