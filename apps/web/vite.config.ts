import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  return {
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
