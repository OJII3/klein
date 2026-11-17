import { defineConfig } from "vite";
import { preact } from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4310",
    },
  },
  build: {
    outDir: "../../dist/web",
    // Keep the previous hashed assets. A document cached by a browser or the
    // Cloudflare edge must still find the chunks it references after a rebuild.
    emptyOutDir: false,
  },
});
