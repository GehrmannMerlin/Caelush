import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type { SkillCatalogItemV1, SkillSelectionV1, WorkspaceId } from "@caelush/protocol";
import type { SkillCatalogListSkills } from "../application/skill-catalog-store.js";

type PickerState = "LOADING" | "READY" | "ERROR";

export interface SkillPickerProps {
  readonly workspaceId: WorkspaceId;
  readonly listSkills: SkillCatalogListSkills;
  readonly selectedSkills: readonly SkillSelectionV1[];
  readonly onSelect: (selection: SkillSelectionV1) => void;
  readonly onEscape?: (() => void) | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly autoFocusSearch?: boolean | undefined;
}

export function SkillPicker(props: SkillPickerProps): ReactElement {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly SkillCatalogItemV1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [state, setState] = useState<PickerState>("LOADING");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const requestGeneration = useRef(0);
  const loadMoreController = useRef<AbortController | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedSkillIds = new Set(props.selectedSkills.map((skill) => skill.skillId));

  useEffect(() => {
    if (props.autoFocusSearch === true) searchRef.current?.focus();
  }, [props.autoFocusSearch]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    loadMoreController.current?.abort();
    loadMoreController.current = undefined;
    setState("LOADING");
    setItems([]);
    setNextCursor(undefined);
    setLoadingMore(false);
    setLoadMoreError(false);
    void props
      .listSkills({
        workspaceId: props.workspaceId,
        query,
        signal: controller.signal,
      })
      .then((page) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setState("READY");
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setState("ERROR");
      });
    return () => {
      controller.abort();
      loadMoreController.current?.abort();
      loadMoreController.current = undefined;
      requestGeneration.current += 1;
    };
  }, [props.listSkills, props.workspaceId, query]);

  const loadMore = async () => {
    if (nextCursor === undefined || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const page = await props.listSkills({
        workspaceId: props.workspaceId,
        query,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (generation !== requestGeneration.current) return;
      setItems((current) => appendUniqueSkills(current, page.items));
      setNextCursor(page.nextCursor);
    } catch {
      if (generation === requestGeneration.current) setLoadMoreError(true);
    } finally {
      if (loadMoreController.current === controller) loadMoreController.current = undefined;
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  };

  const onPickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && event.target === searchRef.current) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      props.onEscape?.();
      return;
    }
    if (event.key === "ArrowDown" && event.target === searchRef.current) {
      event.preventDefault();
      listRef.current?.querySelector<HTMLButtonElement>(".skill-picker-item")?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>(".skill-picker-item") ?? [],
      );
      const currentIndex = buttons.indexOf(event.target as HTMLButtonElement);
      if (currentIndex === -1 || buttons.length === 0) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      buttons[(currentIndex + direction + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <section
      className="skill-picker-panel"
      id="prompt-skill-picker"
      aria-label="选择技能"
      onKeyDown={onPickerKeyDown}
    >
      {props.onBack === undefined ? null : (
        <button className="skill-picker-back" type="button" onClick={props.onBack}>
          返回添加
        </button>
      )}
      <label className="skill-picker-search-label" htmlFor="skill-picker-search">
        搜索技能
      </label>
      <input
        ref={searchRef}
        id="skill-picker-search"
        className="skill-picker-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索技能名称或简介"
        autoComplete="off"
      />
      <div ref={listRef} className="skill-picker-list" role="list" aria-label="技能列表">
        {state === "LOADING" ? (
          <p className="skill-picker-status" role="status">
            正在加载技能…
          </p>
        ) : state === "ERROR" ? (
          <p className="skill-picker-status" role="alert">
            技能目录暂时无法加载。
          </p>
        ) : items.length === 0 ? (
          <p className="skill-picker-status" role="status">
            没有匹配的技能。
          </p>
        ) : (
          items.map((item) => {
            const selected = selectedSkillIds.has(item.skillId);
            const label = item.displayName ?? item.name;
            return (
              <div key={item.skillId} role="listitem">
                <button
                  className="skill-picker-item"
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${label}${selected ? "，已选择" : ""}`}
                  onClick={() => {
                    if (!selected) {
                      props.onSelect({ skillId: item.skillId, selectionToken: item.selectionToken });
                    }
                  }}
                >
                  <span className="skill-picker-item-copy">
                    <span className="skill-picker-item-name">{label}</span>
                    <span className="skill-picker-item-description">{item.description}</span>
                  </span>
                  <span className="skill-picker-item-state" aria-hidden="true">
                    {selected ? "已选" : "添加"}
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
      {loadMoreError ? (
        <p className="skill-picker-load-more-error" role="status">
          无法加载更多技能，请重试。
        </p>
      ) : null}
      {nextCursor === undefined ? null : (
        <button
          className="skill-picker-load-more"
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "正在加载…" : "更多技能"}
        </button>
      )}
    </section>
  );
}

function appendUniqueSkills(
  current: readonly SkillCatalogItemV1[],
  next: readonly SkillCatalogItemV1[],
): readonly SkillCatalogItemV1[] {
  const byId = new Map(current.map((item) => [item.skillId, item]));
  for (const item of next) byId.set(item.skillId, item);
  return [...byId.values()];
}
