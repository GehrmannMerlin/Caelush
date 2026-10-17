import { createElement, Fragment, useState, type ReactElement } from "react";
import { ArrowLeft } from "lucide-react";
import { AppearanceModeSelector } from "@caelush/ui-theme/appearance-selector";
import type { AppearanceSnapshot, ThemePreference } from "@caelush/ui-theme/appearance";

export interface AppearancePageProps {
  readonly snapshot: AppearanceSnapshot;
  readonly onBack: () => void;
  readonly onPreferenceChange: (preference: ThemePreference) => Promise<unknown>;
}

export function AppearancePage(props: AppearancePageProps): ReactElement {
  const [error, setError] = useState<string | undefined>();
  const changePreference = async (preference: ThemePreference): Promise<void> => {
    setError(undefined);
    try {
      await props.onPreferenceChange(preference);
    } catch {
      setError("已应用，但外观设置未能保存，请重试。");
    }
  };

  return createElement(
    "main",
    { className: "appearance-page" },
    createElement(
      "div",
      { className: "appearance-page-content" },
      createElement(
        "button",
        { type: "button", className: "appearance-page-back", onClick: props.onBack },
        createElement(ArrowLeft, { size: 16, strokeWidth: 2, "aria-hidden": true }),
        "返回工作台",
      ),
      createElement("h1", null, "外观"),
      createElement(
        "section",
        { className: "appearance-page-card", "aria-label": "外观设置" },
        createElement(AppearanceModeSelector, {
          snapshot: props.snapshot,
          error,
          onPreferenceChange: changePreference,
        }),
      ),
    ),
  );
}

export interface WorkbenchAppearanceRouteProps {
  readonly isOpen: boolean;
  readonly snapshot: AppearanceSnapshot;
  readonly workbench: ReactElement;
  readonly onBack: () => void;
  readonly onPreferenceChange: (preference: ThemePreference) => Promise<unknown>;
}

export function WorkbenchAppearanceRoute(props: WorkbenchAppearanceRouteProps): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(
      "div",
      {
        className: "workbench-appearance-host",
        style: { display: props.isOpen ? "none" : "contents" },
        "aria-hidden": props.isOpen || undefined,
        inert: props.isOpen,
      },
      props.workbench,
    ),
    props.isOpen
      ? createElement(AppearancePage, {
          snapshot: props.snapshot,
          onBack: props.onBack,
          onPreferenceChange: props.onPreferenceChange,
        })
      : null,
  );
}
