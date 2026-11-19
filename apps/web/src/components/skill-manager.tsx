import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";
import type { CaelushClient } from "@caelush/client";
import type {
  SkillManagementPageV1,
  SkillManagementItemV1,
  SkillImportTarget,
  WorkspaceId,
} from "@caelush/protocol";

export type SkillManagerClient = Pick<
  CaelushClient,
  "listManagedSkills" | "updateSkillSettings" | "importSkills"
>;

export interface SkillManagerProps {
  readonly workspaceId: WorkspaceId;
  readonly client: SkillManagerClient;
  readonly onClose: () => void;
  readonly initialPage?: SkillManagementPageV1 | undefined;
}

interface PackageImport {
  readonly index: number;
  readonly files: readonly { readonly relativePath: string; readonly file: File }[];
}

export function SkillManager(props: SkillManagerProps): ReactElement {
  const [page, setPage] = useState<SkillManagementPageV1 | undefined>(props.initialPage);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [workingSkillId, setWorkingSkillId] = useState<string | undefined>();
  const [importTarget, setImportTarget] = useState<SkillImportTarget>("CURRENT_PROJECT");
  const [importStatus, setImportStatus] = useState<string | undefined>();
  const [packageResults, setPackageResults] = useState<readonly string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setLoadError(false);
    try {
      const items: SkillManagementItemV1[] = [];
      let cursor: string | undefined;
      let response: SkillManagementPageV1 | undefined;
      do {
        response = await props.client.listManagedSkills(props.workspaceId, {
          q: query.trim() || undefined,
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (requestGeneration !== generation.current) return false;
        items.push(...response.items);
        cursor = response.nextCursor;
      } while (cursor !== undefined);
      setPage({ ...response, items });
      return true;
    } catch {
      if (requestGeneration === generation.current) setLoadError(true);
      return false;
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [props.client, props.workspaceId, query]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    inputRef.current?.setAttribute("webkitdirectory", "");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [props.onClose]);

  const updateSetting = async (
    item: SkillManagementItemV1,
    patch: { readonly enabled?: boolean; readonly modelInvocable?: boolean },
  ) => {
    if (page === undefined || workingSkillId !== undefined) return;
    const requestPage = page;
    setWorkingSkillId(item.skillId);
    setImportStatus(undefined);
    try {
      const result = await props.client.updateSkillSettings(props.workspaceId, item.skillId, {
        ...patch,
        expectedCatalogRevision: requestPage.catalogRevision,
      });
      setPage((current) =>
        current === undefined
          ? current
          : {
              ...current,
              catalogRevision: result.catalogRevision,
              items: current.items.map((candidate) =>
                candidate.skillId === item.skillId
                  ? {
                      ...candidate,
                      enabled: result.settings.enabled,
                      modelInvocable: result.settings.modelInvocable,
                      userInvocable: result.settings.enabled && candidate.userInvocable,
                    }
                  : candidate,
              ),
            },
      );
      setImportStatus("技能设置已保存。");
      void refresh();
    } catch {
      setImportStatus("技能设置未保存，请刷新目录后重试。");
    } finally {
      setWorkingSkillId(undefined);
    }
  };

  const importDirectory = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    setPackageResults([]);
    setImportStatus(undefined);
    const packages = groupSkillPackages(files);
    if (packages.length === 0) {
      setImportStatus("所选文件夹中没有找到 SKILL.md。");
      return;
    }
    setLoading(true);
    const results: string[] = [];
    for (const skillPackage of packages) {
      try {
        const receipt = await props.client.importSkills(props.workspaceId, {
          target: importTarget,
          files: skillPackage.files,
        });
        results.push(`技能包 ${skillPackage.index}：${receipt.name} 已导入。`);
        setPackageResults([...results]);
        // A successful package refreshes the displayed facts. A later package failure keeps
        // this last committed catalog page intact because refresh only replaces it on success.
        await refresh();
      } catch {
        results.push(`技能包 ${skillPackage.index}：导入失败，原有技能目录已保留。`);
        setPackageResults([...results]);
      }
    }
    setImportStatus("技能包导入已完成。");
    setLoading(false);
  };

  return (
    <div
      className="skill-manager-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        className="skill-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-manager-title"
      >
        <header className="skill-manager-header">
          <div>
            <p className="skill-manager-eyebrow">工作区资源</p>
            <h2 id="skill-manager-title">技能管理</h2>
          </div>
          <button
            className="skill-manager-close"
            type="button"
            onClick={props.onClose}
            aria-label="关闭技能管理"
          >
            ×
          </button>
        </header>
        <div className="skill-manager-import">
          <label className="skill-manager-label" htmlFor="skill-manager-target">
            导入位置
          </label>
          <div className="skill-manager-import-controls">
            <select
              id="skill-manager-target"
              value={importTarget}
              onChange={(event) => setImportTarget(event.currentTarget.value as SkillImportTarget)}
              disabled={loading}
            >
              <option value="CURRENT_PROJECT">当前项目</option>
              <option value="ALL_PROJECTS">所有项目</option>
            </select>
            <button type="button" disabled={loading} onClick={() => inputRef.current?.click()}>
              选择技能包文件夹
            </button>
            <input
              ref={inputRef}
              className="skill-manager-file-input"
              type="file"
              multiple
              autoFocus={false}
              data-directory-picker="true"
              onChange={(event) => void importDirectory(event)}
              aria-label="选择技能包文件夹"
            />
          </div>
          <p className="skill-manager-hint">
            选取一个或多个技能包文件夹；正文只发送给本地 daemon。
          </p>
          {packageResults.length === 0 ? null : (
            <ul className="skill-manager-import-results" aria-label="导入结果">
              {packageResults.map((result, index) => (
                <li key={index}>{result}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="skill-manager-catalog-header">
          <label className="skill-manager-label" htmlFor="skill-manager-search">
            技能目录
          </label>
          <button type="button" disabled={loading} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        <input
          id="skill-manager-search"
          className="skill-manager-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索名称或简介"
        />
        <div className="skill-manager-list" aria-label="已管理技能">
          {loading && page === undefined ? <p role="status">正在读取技能目录…</p> : null}
          {loadError ? (
            <p className="skill-manager-error" role="alert">
              技能目录读取失败；已保留上次加载的目录。
            </p>
          ) : null}
          {page?.items.length === 0 && !loading ? <p role="status">当前没有技能。</p> : null}
          {page?.items.map((item) => (
            <article
              className={`skill-manager-item${item.enabled ? "" : " is-disabled"}`}
              key={item.skillId}
            >
              <div className="skill-manager-item-copy">
                <h3>{item.displayName ?? item.name}</h3>
                <p>{item.description}</p>
                <span className="skill-manager-policy">
                  {item.modelInvocable
                    ? "可由模型调用"
                    : item.enabled && item.userInvocable
                      ? "仅手动"
                      : "不可调用"}
                </span>
              </div>
              <div className="skill-manager-item-controls">
                <button
                  type="button"
                  className="skill-manager-toggle"
                  aria-pressed={item.enabled}
                  aria-label={`${item.enabled ? "停用" : "启用"}技能 ${item.displayName ?? item.name}`}
                  disabled={loading || workingSkillId !== undefined}
                  onClick={() => void updateSetting(item, { enabled: !item.enabled })}
                >
                  {item.enabled ? "已启用" : "已停用"}
                </button>
                <button
                  type="button"
                  className="skill-manager-toggle"
                  aria-pressed={!item.modelInvocable}
                  aria-label={`${item.modelInvocable ? "设为仅手动" : "允许模型调用"}：${item.displayName ?? item.name}`}
                  disabled={
                    loading || workingSkillId !== undefined || !item.enabled || !item.userInvocable
                  }
                  onClick={() => void updateSetting(item, { modelInvocable: !item.modelInvocable })}
                >
                  {item.modelInvocable ? "模型可调用" : "仅手动"}
                </button>
              </div>
            </article>
          ))}
        </div>
        <p className="skill-manager-status" role="status" aria-live="polite">
          {importStatus ?? (loading ? "正在处理技能目录…" : "")}
        </p>
        <footer className="skill-manager-footer">
          <span>{page?.items.length ?? 0} 个技能</span>
          <button type="button" onClick={props.onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}

export function groupSkillPackages(files: readonly File[]): readonly PackageImport[] {
  if (files.length === 0 || files.length > 4096) return [];
  const paths = files.map((file) => (file.webkitRelativePath || file.name).replaceAll("\\", "/"));
  const firstSegment = paths[0]?.split("/")[0];
  const sharedDirectory =
    firstSegment !== undefined &&
    paths.some((path) => path.includes("/")) &&
    paths.every((path) => path.startsWith(`${firstSegment}/`));
  const relativePaths = paths.map((path) =>
    sharedDirectory ? path.slice(firstSegment!.length + 1) : path,
  );
  const manifestRoots = relativePaths
    .map((path) =>
      path.endsWith("/SKILL.md")
        ? path.slice(0, -"/SKILL.md".length)
        : path === "SKILL.md"
          ? ""
          : undefined,
    )
    .filter((root): root is string => root !== undefined);
  const roots = [...new Set(manifestRoots)].sort((left, right) => left.localeCompare(right));
  return roots.map((root, index) => {
    const prefix = root.length === 0 ? "" : `${root}/`;
    const packageFiles = files.flatMap((file, fileIndex) => {
      const relativePath = relativePaths[fileIndex]!;
      const nearestRoot = roots
        .filter(
          (candidate) =>
            candidate.length === 0 ||
            relativePath === `${candidate}/SKILL.md` ||
            relativePath.startsWith(`${candidate}/`),
        )
        .sort((left, right) => right.length - left.length)[0];
      if (nearestRoot !== root) return [];
      return [{ relativePath: relativePath.slice(prefix.length), file }];
    });
    return { index: index + 1, files: packageFiles };
  });
}
