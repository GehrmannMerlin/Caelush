import { fileURLToPath } from "node:url";

export const daemonEntryPath = fileURLToPath(new URL("./main.js", import.meta.url));
