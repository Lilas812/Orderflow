import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./renderer", import.meta.url)),
  base: "./",
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: true,
    allowedHosts: ["127.0.0.1"],
    fs: { strict: true, allow: [
      "../web/src", "./renderer", "../../packages/core/src", "../../packages/render/src",
      "../../packages/fixtures/src", "../../node_modules",
    ].map(p => fileURLToPath(new URL(p, import.meta.url))) },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
