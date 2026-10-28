import "../components/settings-ui.css";
import { INTEGER_RANGES, defaults, readDocument, validateSettings, type SettingsDocument, type SettingsKey, type SettingsValues } from "./settings-schema.ts";

type Spec = { key: SettingsKey; label: string; group: string } & (
  { kind: "bool" } | { kind: "choice"; choices: Record<string, string> } | { kind: "int" });

export const LONGVP_FIELDS: Spec[] = [
  { key: "showPrice", label: "価格を表示", group: "価格", kind: "bool" },
  { key: "priceStyle", label: "価格の描き方", group: "価格", kind: "choice", choices: { line: "線", candles: "ローソク足" } },
  { key: "showVp", label: "期間VPを表示", group: "期間VP", kind: "bool" },
  { key: "vpPeriod", label: "期間", group: "期間VP", kind: "choice", choices: { day: "日ごと（取引日）", week: "週ごと" } },
  { key: "rthOnly", label: "RTH だけ（CT 8:30〜15:00）", group: "期間VP", kind: "bool" },
  { key: "vpNormalization", label: "横幅の基準", group: "期間VP", kind: "choice", choices: { period: "期間ごとに正規化", global: "全期間共通" } },
  { key: "vpWidthPct", label: "最大の棒の横幅（期間幅の%）", group: "期間VP", kind: "int" },
  { key: "vpTickGroup", label: "表示の価格刻み（ティック、1 = 0.25pt）", group: "期間VP", kind: "int" },
  { key: "showPoc", label: "POC の線とラベル", group: "VAH・POC・VAL", kind: "bool" },
  { key: "showVah", label: "VAH の線とラベル", group: "VAH・POC・VAL", kind: "bool" },
  { key: "showVal", label: "VAL の線とラベル", group: "VAH・POC・VAL", kind: "bool" },
  { key: "showValueArea", label: "バリューエリアの縦線（70%）", group: "VAH・POC・VAL", kind: "bool" },
  { key: "showPocExtension", label: "POC を次の期間へ延長", group: "VAH・POC・VAL", kind: "bool" },
  { key: "showWeeklyVwap", label: "週VWAP", group: "週ごとの線", kind: "bool" },
  { key: "showWeeklyCvd", label: "週CVD（オフで下段を消す）", group: "週ごとの線", kind: "bool" },
];

const url = () => `${import.meta.env.BASE_URL}api/settings/longvp`;
async function request(values?: SettingsValues): Promise<SettingsDocument> {
  const c = new AbortController(), timer = setTimeout(() => c.abort(), 10000);
  try {
    const res = await fetch(url(), { method: values ? "PUT" : "GET", cache: "no-store", credentials: "include", signal: c.signal,
      ...(values ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) } : {}) });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const b = body as { fields?: Record<string, string>; error?: string } | null;
      throw Error(Object.values(b?.fields ?? {}).join(" / ") || b?.error || (values ? `設定を保存できませんでした（HTTP ${res.status}）` : `設定を読めませんでした（HTTP ${res.status}）`));
    }
    const doc = readDocument(body);
    if (!doc) throw Error("設定の応答が不正です");
    return doc;
  } catch (e) {
    if (c.signal.aborted) throw Error("設定の通信が10秒でタイムアウトしました");
    throw e;
  } finally { clearTimeout(timer); }
}
export const fetchLongVpSettings = () => request();
export const putLongVpSettings = (values: SettingsValues) => request(values);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "不明な理由";

/** Raw form inputs -> typed candidate values (integers stay strings until parsed). */
export function inputsToValues(inputs: Record<SettingsKey, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of LONGVP_FIELDS) {
    const v = inputs[f.key];
    if (f.kind === "int") { const s = String(v).trim(); out[f.key] = s === "" || !/^-?\d+(\.\d+)?$/.test(s) ? s : Number(s); }
    else out[f.key] = v;
  }
  return out;
}

export function mountLongVpSettings(opts: {
  button: HTMLButtonElement; onSaved: (doc: SettingsDocument) => void; onOpenChange: (open: boolean) => void;
}) {
  type Status = "loading" | "load-error" | "ready" | "saving";
  let status: Status = "loading", message = "", generation = 0, open = false;
  const inputs = {} as Record<SettingsKey, string | boolean>;
  const dialog = el("dialog", "su-dialog");
  dialog.setAttribute("aria-labelledby", "lv-su-title");
  dialog.dataset.testid = "dialog-longvp-settings";
  const panel = el("div", "su-panel"), head = el("header", "su-head");
  const title = el("h2", "su-title", "長期VP の設定"); title.id = "lv-su-title";
  const close = el("button", "su-close"); close.type = "button"; close.setAttribute("aria-label", "閉じる"); close.title = "閉じる";
  close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.dataset.testid = "button-longvp-settings-close";
  head.append(title, close);
  const body = el("form", "su-body"); body.noValidate = true;
  const notice = el("p", "su-notice"); notice.setAttribute("role", "alert"); notice.dataset.testid = "status-longvp-settings";
  const retry = el("button", "su-btn su-btn-quiet", "再読み込み"); retry.type = "button"; retry.hidden = true;
  retry.dataset.testid = "button-longvp-settings-retry";
  const fields = el("div", "su-fields");
  const foot = el("footer", "su-foot");
  const cancel = el("button", "su-btn su-btn-quiet", "キャンセル"); cancel.type = "button"; cancel.dataset.testid = "button-longvp-settings-cancel";
  const def = el("button", "su-btn su-btn-quiet", "初期値に戻す"); def.type = "button"; def.dataset.testid = "button-longvp-settings-defaults";
  const save = el("button", "su-btn su-btn-save", "保存"); save.type = "submit"; save.dataset.testid = "button-longvp-settings-save";
  foot.append(cancel, def, save);
  body.append(notice, retry, fields, foot);
  panel.append(head, body); dialog.append(panel); document.body.append(dialog);

  const controls = new Map<SettingsKey, HTMLInputElement | HTMLSelectElement>();
  const errs = new Map<SettingsKey, HTMLElement>();
  let group = "";
  for (const f of LONGVP_FIELDS) {
    if (f.group !== group) { fields.append(el("h3", "su-group", f.group)); group = f.group; }
    const row = el("div", "su-field"), id = `lv-su-${f.key}`;
    const err = el("p", "su-error"); err.id = `${id}-err`; err.dataset.testid = `error-${f.key}`;
    let control: HTMLInputElement | HTMLSelectElement;
    if (f.kind === "bool") {
      row.classList.add("su-inline");
      const label = el("label", "su-check"); const box = el("input"); box.type = "checkbox";
      label.append(box, document.createTextNode(f.label)); row.append(label);
      control = box;
      box.addEventListener("change", () => { inputs[f.key] = box.checked; render(false); });
    } else {
      const label = el("label", "su-label", f.label); label.htmlFor = id;
      const line = el("div", "su-line");
      if (f.kind === "choice") {
        const s = el("select", "su-input");
        for (const [v, t] of Object.entries(f.choices)) { const o = el("option", undefined, t); o.value = v; s.append(o); }
        control = s;
      } else {
        const i = el("input", "su-input su-num"); i.type = "text"; i.inputMode = "numeric"; i.autocomplete = "off";
        control = i;
        const [min, max] = INTEGER_RANGES[f.key as keyof typeof INTEGER_RANGES];
        line.append(i, el("span", "su-hint", `${min}〜${max}の整数`));
      }
      if (f.kind === "choice") line.append(control);
      row.append(label, line);
      control.addEventListener("input", () => { inputs[f.key] = control.value; render(false); });
    }
    control.id = id; control.dataset.testid = `input-${f.key}`;
    control.setAttribute("aria-describedby", err.id);
    row.append(err); fields.append(row);
    controls.set(f.key, control); errs.set(f.key, err);
  }

  function setInputs(v: SettingsValues) {
    for (const f of LONGVP_FIELDS) inputs[f.key] = f.kind === "bool" ? v[f.key] as boolean : String(v[f.key]);
  }
  setInputs(defaults);

  function render(sync: boolean) {
    const errors = validateSettings(inputsToValues(inputs));
    const usable = status === "ready";
    for (const f of LONGVP_FIELDS) {
      const c = controls.get(f.key)!;
      if (sync) { if (c instanceof HTMLInputElement && c.type === "checkbox") c.checked = inputs[f.key] as boolean; else c.value = String(inputs[f.key]); }
      c.disabled = !usable;
      const msg = usable ? errors[f.key] ?? "" : "";
      errs.get(f.key)!.textContent = msg; c.toggleAttribute("aria-invalid", !!msg);
    }
    notice.textContent = status === "loading" ? "サーバーの最新の設定を読み込み中…" : status === "saving" ? "保存中…" : message;
    notice.dataset.tone = status === "load-error" || (status === "ready" && message) ? "error" : "info";
    retry.hidden = status !== "load-error";
    save.disabled = !usable || Object.keys(errors).length > 0;
    save.textContent = status === "saving" ? "保存中…" : "保存";
    def.disabled = !usable;
  }

  async function load() {
    const gen = ++generation;
    status = "loading"; message = ""; render(true);
    try {
      const doc = await fetchLongVpSettings();
      if (gen !== generation || !open) return;
      setInputs(doc.values); status = "ready";
    } catch (e) {
      if (gen !== generation || !open) return;
      status = "load-error"; message = `設定を読めませんでした：${reason(e)}。保存はできません。`;
    }
    render(true);
  }
  function show() {
    if (!open) { open = true; dialog.showModal(); opts.onOpenChange(true); }
    void load();
  }
  function hide() {
    generation++;
    if (!open) return;
    open = false; if (dialog.open) dialog.close(); opts.onOpenChange(false);
    opts.button.focus({ preventScroll: true });
  }
  async function submit() {
    const candidate = inputsToValues(inputs);
    if (status !== "ready" || Object.keys(validateSettings(candidate)).length) return;
    const gen = generation;
    status = "saving"; message = ""; render(false);
    try {
      const doc = await putLongVpSettings(candidate as unknown as SettingsValues);
      opts.onSaved(doc);
      if (gen === generation && open) hide();
      status = "ready";
    } catch (e) {
      if (gen !== generation || !open) return;
      status = "ready"; message = `保存できませんでした：${reason(e)}。表示は変えていません。`; render(false);
    }
  }
  const onClick = () => show();
  opts.button.addEventListener("click", onClick);
  close.addEventListener("click", hide);
  cancel.addEventListener("click", hide);
  retry.addEventListener("click", () => void load());
  def.addEventListener("click", () => { setInputs(defaults); message = ""; render(true); });
  body.addEventListener("submit", e => { e.preventDefault(); void submit(); });
  dialog.addEventListener("cancel", e => { e.preventDefault(); hide(); });
  dialog.addEventListener("click", e => { if (e.target === dialog) hide(); });
  render(true);
  return { destroy() { hide(); opts.button.removeEventListener("click", onClick); dialog.remove(); } };
}
