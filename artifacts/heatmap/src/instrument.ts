import { INSTRUMENTS, instrumentPrice, marketSymbol } from "../../../lib/market/instruments.ts";

const KEY = "heatmap.instrument";
function storedSymbol() {
  try { return typeof window === "undefined" ? "NQ" : marketSymbol(window.sessionStorage.getItem(KEY)) ?? "NQ"; }
  catch { return "NQ"; }
}
/** Immutable for a document: a switch reloads it, discarding every old cache/request/cursor. */
export const ACTIVE_SYMBOL = storedSymbol();
export const ACTIVE_INSTRUMENT = INSTRUMENTS[ACTIVE_SYMBOL];
export const formatInstrumentPrice = (ticks: number) => instrumentPrice(ticks, ACTIVE_SYMBOL);
export function symbolUrl(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return path + separator + "symbol=" + ACTIVE_SYMBOL;
}
export function instrumentSelectHtml() {
  return `<label class="instrument-selector">銘柄 <select aria-label="銘柄" data-testid="instrument-select">
    ${["NQ", "GC"].map(s => `<option value="${s}"${s === ACTIVE_SYMBOL ? " selected" : ""}>${s}</option>`).join("")}
    </select></label>`;
}
export function initializeInstrumentUi() {
  // A URL retained from another tab must not override this tab's selection.
  const url = new URL(window.location.href);
  if (ACTIVE_SYMBOL === "GC") url.searchParams.set("symbol", "GC"); else url.searchParams.delete("symbol");
  window.history.replaceState(null, "", url);
  document.addEventListener("change", event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || select.dataset.testid !== "instrument-select") return;
    const symbol = marketSymbol(select.value);
    if (!symbol || symbol === ACTIVE_SYMBOL) return;
    try { window.sessionStorage.setItem(KEY, symbol); }
    catch { select.value = ACTIVE_SYMBOL; window.alert("このタブの銘柄選択を保存できません。切り替えを中止しました。"); return; }
    window.dispatchEvent(new Event("market-switch"));
    window.location.reload();
  });
}
