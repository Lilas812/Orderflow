// Isolated validation only. Never used by the running managed workflow.
import { defineConfig, mergeConfig } from 'vite';
import current from './vite.config';
import rangePlugin from './scripts/range-plugin.mjs';
export default defineConfig(mergeConfig(current, {
  publicDir: false,
  define: { 'import.meta.env.VITE_RANGE_RESEARCH_ENABLED': JSON.stringify('1') },
  plugins: [rangePlugin()],
}));
