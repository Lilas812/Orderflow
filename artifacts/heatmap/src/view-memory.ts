/** Per-tab, per-screen, per-symbol view memory. Navigation reloads the document, so this is the only carrier. */
export function loadView<T>(screen: "heatmap" | "footprint" | "longvp", symbol: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(`view.${screen}.${symbol}`);
    return raw ? JSON.parse(raw) as T : null;
  } catch { return null; }
}
export function saveView(screen: "heatmap" | "footprint" | "longvp", symbol: string, value: unknown): void {
  try { window.sessionStorage.setItem(`view.${screen}.${symbol}`, JSON.stringify(value)); } catch { /* storage unavailable: view not kept */ }
}
