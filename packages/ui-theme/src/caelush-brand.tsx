import { createElement, type ImgHTMLAttributes, type ReactElement } from "react";
import type { ResolvedTheme } from "./appearance.js";

export interface CaelushBrandProps {
  readonly kind: "icon" | "logo";
  readonly theme: ResolvedTheme;
  readonly lightSrc: string;
  readonly darkSrc: string;
  readonly alt?: string | undefined;
  readonly className?: string | undefined;
  readonly loading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
}

export function CaelushBrand(props: CaelushBrandProps): ReactElement {
  return createElement("img", {
    className: ["caelush-brand", props.className].filter(Boolean).join(" "),
    src: props.theme === "dark" ? props.darkSrc : props.lightSrc,
    alt: props.alt ?? "Caelush",
    "data-caelush-brand-kind": props.kind,
    "data-caelush-brand-theme": props.theme,
    loading: props.loading,
  });
}
