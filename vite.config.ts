import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, "web"),
  plugins: [react()],
  resolve: {
    alias: {
      "@klein/webui": resolve(projectRoot, "src/modules/webui"),
    },
  },
  build: {
    outDir: resolve(projectRoot, "dist/web"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.KLEIN_WEBUI_API_ORIGIN ?? "http://127.0.0.1:4310",
        changeOrigin: true,
      },
    },
  },
});
