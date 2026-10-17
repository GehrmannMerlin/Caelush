import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const desktopBuild = mode === "desktop";
  return {
    base: desktopBuild ? "/agent/" : "/",
    build: {
      ...(desktopBuild
        ? {
            outDir: fileURLToPath(new URL("../desktop/.stage/web", import.meta.url)),
            emptyOutDir: true,
            sourcemap: false,
          }
        : {}),
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: "react-vendor",
                test: /node_modules[\\/]\.pnpm[\\/](?:react-dom|react|scheduler)@/,
                priority: 20,
              },
            ],
          },
        },
      },
    },
    plugins: [
      {
        name: "caelush-web-development-bootstrap",
        apply: desktopBuild ? "build" : "serve",
        transformIndexHtml(html) {
          return html.replace("__CAELUSH_BOOTSTRAP__", "{}");
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api/v1": {
          target: environment.CAELUSH_DAEMON_URL || "http://127.0.0.1:43120",
          changeOrigin: false,
        },
      },
    },
  };
});
