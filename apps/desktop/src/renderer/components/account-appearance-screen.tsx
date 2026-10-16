import { createElement, type ReactElement } from "react";
import {
  AppearanceModeSelector,
  type AppearanceSnapshot,
  type ThemePreference,
} from "@caelush/ui-theme";
import type { DesktopAppearanceApi } from "../../preload/api-types.js";

export interface AccountAppearanceScreenProps {
  readonly api?: DesktopAppearanceApi | undefined;
  readonly snapshot: AppearanceSnapshot;
  readonly error?: string | null | undefined;
  readonly onPreferenceChange: (preference: ThemePreference) => Promise<unknown>;
}

export function AccountAppearanceScreen(props: AccountAppearanceScreenProps): ReactElement {
  return createElement(
    "div",
    { className: "account-appearance-screen" },
    createElement(
      "section",
      { className: "detail-panel account-appearance-panel", "aria-label": "外观设置" },
      props.api === undefined
        ? createElement(
            "div",
            { className: "account-appearance-unavailable", role: "status" },
            createElement("h3", null, "外观设置暂不可用"),
            createElement("p", null, "当前 Desktop 版本不支持外观设置，请更新应用后重试。"),
          )
        : createElement(AppearanceModeSelector, {
            snapshot: props.snapshot,
            error: props.error,
            onPreferenceChange: props.onPreferenceChange,
          }),
    ),
  );
}
