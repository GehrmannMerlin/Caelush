import type { DesktopApi } from "./api-types.js";

declare global {
  interface Window {
    readonly caelushDesktop: DesktopApi;
  }
}

export {};
