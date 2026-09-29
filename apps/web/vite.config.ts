import { defineConfig } from "vite";

export default defineConfig({
  server: { proxy: { "/v1": "http://localhost:8787", "/health": "http://localhost:8787" } },
  build: { outDir: "dist", emptyOutDir: true },
});
