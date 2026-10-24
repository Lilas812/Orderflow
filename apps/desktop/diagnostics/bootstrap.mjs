import { installObserver } from "../../web/src/diagnostics/load29-browser/observer.mjs";

// Diagnostic-only production entry. The distributed desktop renderer is not
// replaced on disk. All calculations/UI remain the shared session/ChartShell.
// Native-only geometry identity; ordinary browser observer remains unchanged.
installObserver({ identifyLayout(canvas) {
  const r = canvas.getBoundingClientRect();
  return { phase: window.__desktopLayout?.phase ?? "initial",
    generation: window.__desktopLayout?.read().epoch ?? 0,
    at: performance.now(), dpr: devicePixelRatio,
    cssWidth: r.width, cssHeight: r.height };
} });
const input = new Promise(resolve => {
  window.addEventListener("desktop-a2-input", event => {
    window.__load29Input = { ...event.detail, host: "electron" };
    resolve();
  }, { once: true });
});
window.__desktopA2Ready = true;
void input.then(() => import("../../web/src/diagnostics/load29-browser/entry"));
