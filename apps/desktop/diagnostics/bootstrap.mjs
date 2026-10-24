import { installObserver } from "../../web/src/diagnostics/load29-browser/observer.mjs";

// Diagnostic-only production entry. The distributed desktop renderer is not
// replaced on disk. All calculations/UI remain the shared session/ChartShell.
installObserver();
const input = new Promise(resolve => {
  window.addEventListener("desktop-a2-input", event => {
    window.__load29Input = { ...event.detail, host: "electron" };
    resolve();
  }, { once: true });
});
window.__desktopA2Ready = true;
void input.then(() => import("../../web/src/diagnostics/load29-browser/entry"));
