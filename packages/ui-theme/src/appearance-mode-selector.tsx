import { createElement, useId, type ChangeEvent, type ReactElement } from "react";
import type { AppearanceSnapshot, ThemePreference } from "./appearance.js";

const modes: readonly { readonly value: ThemePreference; readonly label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

export interface AppearanceModeSelectorProps {
  readonly snapshot: AppearanceSnapshot;
  readonly error?: string | null | undefined;
  readonly onPreferenceChange: (preference: ThemePreference) => void | Promise<unknown>;
}

export function AppearanceModeSelector(props: AppearanceModeSelectorProps): ReactElement {
  const groupName = useId();
  const systemLabel = `当前使用${props.snapshot.resolvedTheme === "light" ? "浅色" : "深色"}`;

  const selectPreference = (event: ChangeEvent<HTMLInputElement>) => {
    const preference = event.currentTarget.value as ThemePreference;
    try {
      void Promise.resolve(props.onPreferenceChange(preference)).catch(() => undefined);
    } catch {
      // The owning settings surface is responsible for showing persistence feedback.
    }
  };

  return createElement(
    "section",
    { className: "caelush-appearance" },
    createElement(
      "fieldset",
      { className: "caelush-appearance__fieldset" },
      createElement("legend", { className: "caelush-appearance__title" }, "颜色模式"),
      createElement(
        "p",
        { className: "caelush-appearance__description" },
        "选择此设备上的显示模式。",
      ),
      createElement(
        "div",
        { className: "caelush-appearance__options" },
        modes.map((mode) => {
          const resolvedPreview =
            mode.value === "system" ? props.snapshot.resolvedTheme : mode.value;
          return createElement(
            "label",
            {
              className: "caelush-appearance__option",
              key: mode.value,
              "data-selected": props.snapshot.preference === mode.value,
            },
            createElement("input", {
              className: "caelush-appearance__radio",
              type: "radio",
              name: groupName,
              value: mode.value,
              checked: props.snapshot.preference === mode.value,
              onChange: selectPreference,
            }),
            createElement(
              "span",
              {
                className: "caelush-appearance__preview",
                "data-theme": resolvedPreview,
                "aria-hidden": true,
              },
              createElement("span", { className: "caelush-appearance__preview-sidebar" }),
              createElement(
                "span",
                { className: "caelush-appearance__preview-content" },
                createElement("span", { className: "caelush-appearance__preview-line" }),
                createElement("span", { className: "caelush-appearance__preview-input" }),
              ),
            ),
            createElement("span", { className: "caelush-appearance__label" }, mode.label),
          );
        }),
      ),
      props.snapshot.preference === "system"
        ? createElement(
            "p",
            { className: "caelush-appearance__system-status", "aria-live": "polite" },
            systemLabel,
          )
        : null,
      props.error
        ? createElement("p", { className: "caelush-appearance__error", role: "alert" }, props.error)
        : null,
    ),
  );
}
