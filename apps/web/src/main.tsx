import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import { WebHostApp } from "./app.js";
import { createWebCaelushClient } from "./host/client-factory.js";
import "./styles.css";

const launchContext = document.getElementById("caelush-bootstrap")?.textContent;
const client = createWebCaelushClient({ baseUrl: window.location.origin });

createRoot(document.getElementById("root") as HTMLElement).render(
  createElement(StrictMode, null, createElement(WebHostApp, { client, launchContext })),
);
