import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceIdSchema } from "@caelush/protocol";
import { WebHostApp } from "./app.js";
import { createWebCaelushClient } from "./host/client-factory.js";
import { createWebAppearanceController } from "./appearance/web-appearance.js";
import { createDesktopAppearanceController } from "./host/desktop-appearance.js";
import { resolveClientHostIntegration } from "./host/desktop-integration.js";
import "@caelush/ui-theme/styles.css";
import "./styles.css";

const clientHost = resolveClientHostIntegration();
const appearanceController =
  clientHost.kind === "DESKTOP"
    ? createDesktopAppearanceController(clientHost.appearance)
    : createWebAppearanceController();
window.addEventListener("pagehide", () => appearanceController.dispose(), { once: true });
const launchContext = document.getElementById("caelush-bootstrap")?.textContent;
const queryWorkspaceId = new URLSearchParams(window.location.search).get("workspace");
const initialWorkspaceId = WorkspaceIdSchema.safeParse(queryWorkspaceId).success
  ? WorkspaceIdSchema.parse(queryWorkspaceId)
  : undefined;
const client = createWebCaelushClient({ baseUrl: window.location.origin });

createRoot(document.getElementById("root") as HTMLElement).render(
  createElement(
    StrictMode,
    null,
    createElement(WebHostApp, {
      client,
      appearanceController,
      launchContext,
      initialWorkspaceId,
    }),
  ),
);
