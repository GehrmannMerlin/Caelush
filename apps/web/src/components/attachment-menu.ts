import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type Ref,
} from "react";
import { FilePlus2, Pickaxe } from "lucide-react";
import type { SkillSelectionV1, WorkspaceId } from "@caelush/protocol";
import type { SkillCatalogListSkills } from "../application/skill-catalog-store.js";
import { SkillPicker } from "./skill-picker.js";
import type { SelectedSkillTag } from "./selected-skill-list.js";

export interface AttachmentMenuProps {
  readonly onChooseFiles?: (() => void) | undefined;
  readonly skillsEnabled?: boolean | undefined;
  readonly workspaceId?: WorkspaceId | undefined;
  readonly listSkills?: SkillCatalogListSkills | undefined;
  readonly selectedSkills?: readonly SelectedSkillTag[] | undefined;
  readonly onSelectSkill?: ((selection: SkillSelectionV1) => void) | undefined;
  readonly onRemoveSkill?: ((skillId: string) => void) | undefined;
  readonly containerRef?: Ref<HTMLDivElement> | undefined;
}

export function AttachmentMenu(props: AttachmentMenuProps): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [autoFocusSearch, setAutoFocusSearch] = useState(false);
  const [panelSide, setPanelSide] = useState<"left" | "right">("right");
  const [panelShiftX, setPanelShiftX] = useState(0);
  const [panelShiftY, setPanelShiftY] = useState(0);
  const [panelMaxHeight, setPanelMaxHeight] = useState<number | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const skillButtonRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clickLocked = useRef(false);
  const canChooseSkills =
    props.skillsEnabled === true &&
    props.workspaceId !== undefined &&
    props.listSkills !== undefined &&
    props.onSelectSkill !== undefined;
  const selectedSkillIds = new Set((props.selectedSkills ?? []).map((skill) => skill.skillId));

  useEffect(() => {
    const firstAction = rootRef.current?.querySelector<HTMLButtonElement>(".attachment-menu-item");
    if (!pickerOpen) firstAction?.focus();
  }, [pickerOpen]);

  useLayoutEffect(() => {
    if (!pickerOpen) return;
    const updatePlacement = () => {
      const rootBounds = rootRef.current?.getBoundingClientRect();
      const panel = rootRef.current?.querySelector<HTMLElement>(".skill-picker-panel");
      const panelBounds = panel?.getBoundingClientRect();
      if (rootBounds === undefined || panelBounds === undefined) return;
      if (window.innerWidth <= 680) {
        const composerBounds = rootRef.current
          ?.closest<HTMLElement>(".prompt-composer")
          ?.getBoundingClientRect();
        if (composerBounds === undefined) return;
        setPanelMaxHeight(
          resolveMobileSkillMenuMaxHeight({
            composerTop: composerBounds.top,
            viewportHeight: window.innerHeight,
          }),
        );
        setPanelSide("right");
        setPanelShiftX(0);
        setPanelShiftY(0);
        return;
      }
      setPanelMaxHeight(undefined);
      const estimatedPanelWidth = Math.min(352, window.innerWidth - 24);
      const sidebarRight =
        window.innerWidth > 680
          ? Math.max(
              0,
              document.getElementById("caelush-workspace-sidebar")?.getBoundingClientRect().right ??
                0,
            )
          : 0;
      const placement = resolveSkillPanelPlacement({
        viewportWidth: window.innerWidth,
        panelWidth: estimatedPanelWidth,
        menuLeft: rootBounds.left,
        menuRight: rootBounds.right,
        contentLeft: sidebarRight,
      });
      setPanelSide(placement.side);
      setPanelShiftX(window.innerWidth > 680 ? placement.shiftX : 0);
      setPanelShiftY(
        resolveSkillPanelVerticalShift({
          panelTop: panelBounds.top - panelShiftY,
          panelHeight: panelBounds.height,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    return () => window.removeEventListener("resize", updatePlacement);
  }, [panelShiftY, pickerOpen]);

  useEffect(
    () => () => {
      if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const cancelHoverTimer = () => {
    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
  };
  const openFromHover = () => {
    if (!canChooseSkills || clickLocked.current) return;
    cancelHoverTimer();
    hoverTimer.current = setTimeout(() => {
      setAutoFocusSearch(false);
      setPickerOpen(true);
    }, 150);
  };
  const closeFromHover = () => {
    if (clickLocked.current) return;
    cancelHoverTimer();
    hoverTimer.current = setTimeout(() => setPickerOpen(false), 150);
  };
  const openFromClick = () => {
    cancelHoverTimer();
    clickLocked.current = true;
    setAutoFocusSearch(true);
    setPickerOpen(true);
  };
  const returnToActions = () => {
    clickLocked.current = false;
    setPickerOpen(false);
    setAutoFocusSearch(false);
    queueMicrotask(() => skillButtonRef.current?.focus());
  };

  const uploadButton =
    props.onChooseFiles === undefined
      ? null
      : createElement(
          "button",
          { type: "button", className: "attachment-menu-item", onClick: props.onChooseFiles },
          createElement(FilePlus2, { size: 17, "aria-hidden": true }),
          createElement("span", null, "上传文件"),
        );
  const skillButton = canChooseSkills
    ? createElement(
        "button",
        {
          ref: skillButtonRef,
          type: "button",
          className: "attachment-menu-item",
          "aria-expanded": pickerOpen,
          "aria-controls": "prompt-skill-picker",
          onPointerEnter: openFromHover,
          onPointerLeave: (event: { relatedTarget: EventTarget | null }) => {
            if (
              event.relatedTarget instanceof Node &&
              rootRef.current?.contains(event.relatedTarget)
            ) {
              cancelHoverTimer();
              return;
            }
            closeFromHover();
          },
          onClick: openFromClick,
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              openFromClick();
            }
          },
        },
        createElement(Pickaxe, { size: 17, strokeWidth: 1.8, "aria-hidden": true }),
        createElement("span", null, "选择技能"),
        selectedSkillIds.size === 0
          ? null
          : createElement(
              "span",
              {
                className: "attachment-menu-count",
                "aria-label": `${selectedSkillIds.size} 个已选`,
              },
              selectedSkillIds.size,
            ),
      )
    : null;
  const skillPicker =
    pickerOpen &&
    canChooseSkills &&
    props.workspaceId !== undefined &&
    props.listSkills !== undefined
      ? createElement(SkillPicker, {
          workspaceId: props.workspaceId,
          listSkills: props.listSkills,
          selectedSkills: (props.selectedSkills ?? []).map(({ skillId, selectionToken }) => ({
            skillId,
            selectionToken,
          })),
          onSelect: props.onSelectSkill!,
          onBack: returnToActions,
          onEscape: returnToActions,
          autoFocusSearch,
        })
      : null;

  return createElement(
    "div",
    {
      className: `attachment-menu${pickerOpen ? " attachment-menu--skills" : ""}`,
      id: "prompt-attachment-menu",
      ref: (element: HTMLDivElement | null) => {
        rootRef.current = element;
        if (typeof props.containerRef === "function") props.containerRef(element);
        else if (props.containerRef !== null && props.containerRef !== undefined)
          props.containerRef.current = element;
      },
      role: "dialog",
      "aria-label": "添加",
      onPointerEnter: cancelHoverTimer,
      onPointerLeave: (event: { relatedTarget: EventTarget | null }) => {
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) {
          return;
        }
        closeFromHover();
      },
      onKeyDown: (event: { key: string; target: EventTarget; preventDefault: () => void }) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const actions = Array.from(
          rootRef.current?.querySelectorAll<HTMLButtonElement>(".attachment-menu-item") ?? [],
        );
        const index = actions.indexOf(event.target as HTMLButtonElement);
        if (index === -1 || actions.length < 2) return;
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        actions[(index + offset + actions.length) % actions.length]?.focus();
      },
      "data-panel-side": panelSide,
      style: {
        "--skill-picker-inline-shift": `${panelShiftX}px`,
        "--skill-picker-block-shift": `${panelShiftY}px`,
        ...(panelMaxHeight === undefined
          ? {}
          : { "--skill-picker-menu-max-height": `${panelMaxHeight}px` }),
      } as CSSProperties,
    },
    createElement(
      "span",
      { className: "attachment-menu-heading" },
      pickerOpen ? "选择技能" : "添加",
    ),
    createElement("div", { className: "attachment-menu-items" }, uploadButton, skillButton),
    props.onChooseFiles === undefined
      ? null
      : createElement(
          "p",
          { className: "attachment-menu-hint" },
          "也可以将文件拖到输入框，或粘贴截图。",
        ),
    skillPicker,
  );
}

export function resolveSkillPanelPlacement(input: {
  readonly viewportWidth: number;
  readonly panelWidth: number;
  readonly menuLeft: number;
  readonly menuRight: number;
  readonly contentLeft: number;
}): { readonly side: "left" | "right"; readonly shiftX: number } {
  const gutter = 12;
  const gap = 8;
  const minimumLeft = Math.min(input.contentLeft + gutter, input.viewportWidth - gutter);
  const maximumLeft = Math.max(gutter, input.viewportWidth - gutter - input.panelWidth);
  const rightLeft = input.menuRight + gap;
  if (rightLeft <= maximumLeft) return { side: "right", shiftX: 0 };

  const preferredLeft = input.menuLeft - input.panelWidth - gap;
  if (preferredLeft >= minimumLeft && preferredLeft <= maximumLeft) {
    return { side: "left", shiftX: 0 };
  }

  const clampedLeft = Math.min(Math.max(preferredLeft, minimumLeft), maximumLeft);
  const shift = clampedLeft - preferredLeft;
  return {
    side: "left",
    shiftX: shift > 0 ? Math.ceil(shift) : Math.floor(shift),
  };
}

export function resolveSkillPanelVerticalShift(input: {
  readonly panelTop: number;
  readonly panelHeight: number;
  readonly viewportHeight: number;
  readonly gutter?: number;
}): number {
  const gutter = Math.max(0, input.gutter ?? 12);
  const minimumTop = gutter;
  const maximumTop = Math.max(minimumTop, input.viewportHeight - input.panelHeight - gutter);
  const targetTop = Math.min(Math.max(input.panelTop, minimumTop), maximumTop);
  const shift = targetTop - input.panelTop;
  return shift > 0 ? Math.ceil(shift) : Math.floor(shift);
}

export function resolveMobileSkillMenuMaxHeight(input: {
  readonly composerTop: number;
  readonly viewportHeight: number;
}): number {
  const gutter = 12;
  return Math.max(0, Math.min(input.viewportHeight - gutter * 2, input.composerTop - gutter * 2));
}
