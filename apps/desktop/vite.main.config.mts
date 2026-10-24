import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

// Bundle workspace ESM/TypeScript into the existing CJS Electron runtime.
// Preload has no local imports and remains sandbox-compatible.
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: true,
    outDir: "dist/main",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./main/main.ts", import.meta.url)),
        preload: fileURLToPath(new URL("./main/preload.ts", import.meta.url)),
      },
      external: ["electron", ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
      output: { format: "cjs", entryFileNames: "[name].js" },
    },
  },
});
