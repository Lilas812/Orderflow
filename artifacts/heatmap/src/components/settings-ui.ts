import "./settings-ui.css";
import type { SettingsDocument, SettingsKey, SettingsValues } from "../data/settings.ts";
import { FIELD_SPECS, SettingsForm, ZONE_LABELS, rangeText } from "./settings-form.ts";

export interface SettingsUiOptions {
  load: () => Promise<SettingsDocument>;
  save: (values: SettingsValues) => Promise<SettingsDocument>;
  onSaved: (doc: SettingsDocument) => void;
  onReset: () => void;
  overridden: Partial<Record<SettingsKey, boolean>>;
  onModalChange?: (open: boolean) => void;
}

const SVG = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_SETTINGS = `<svg ${SVG}><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`;
const ICON_RESET = `<svg ${SVG}><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><circle cx="12" cy="12" r="1.6"/></svg>`;
const ICON_CLOSE = `<svg ${SVG} width="16" height="16"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "不明な理由";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mountSettingsUi(rail: HTMLElement, options: SettingsUiOptions) {
  const form = new SettingsForm();
  let generation = 0, open = false, destroyed = false;

  rail.replaceChildren();
  rail.classList.add("su-rail");
  const mkTool = (label: string, icon: string, id: string) => {
    const b = el("button", "su-tool");
    b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
    b.dataset.testid = id; b.innerHTML = icon;
    rail.append(b); return b;
  };
  const settingsBtn = mkTool("設定", ICON_SETTINGS, "button-settings");
  const resetBtn = mkTool("表示リセット", ICON_RESET, "button-view-reset");
  settingsBtn.setAttribute("aria-haspopup", "dialog");

  const dialog = el("dialog", "su-dialog");
  dialog.setAttribute("aria-labelledby", "su-title");
  const panel = el("div", "su-panel");
  const head = el("header", "su-head");
  const title = el("h2", "su-title", "設定"); title.id = "su-title";
  const closeBtn = el("button", "su-close");
  closeBtn.type = "button"; closeBtn.title = "閉じる"; closeBtn.setAttribute("aria-label", "閉じる");
  closeBtn.innerHTML = ICON_CLOSE; closeBtn.dataset.testid = "button-settings-close";
  head.append(title, closeBtn);
  const body = el("form", "su-body"); body.noValidate = true;
  const notice = el("p", "su-notice"); notice.setAttribute("role", "alert"); notice.dataset.testid = "status-settings";
  const fields = el("div", "su-fields");
  const foot = el("footer", "su-foot");
  const defaultsBtn = el("button", "su-btn su-btn-quiet", "初期値に戻す"); defaultsBtn.type = "button";
  defaultsBtn.dataset.testid = "button-settings-defaults";
  const saveBtn = el("button", "su-btn su-btn-save", "保存"); saveBtn.type = "submit";
  saveBtn.dataset.testid = "button-settings-save";
  foot.append(defaultsBtn, saveBtn);
  body.append(notice, fields, foot);
  panel.append(head, body);
  dialog.append(panel);
  document.body.append(dialog);

  const controls = new Map<SettingsKey, HTMLInputElement | HTMLSelectElement>();
  const errorEls = new Map<SettingsKey, HTMLElement>();
  let lastGroup = "";
  for (const spec of FIELD_SPECS) {
    if (spec.group !== lastGroup) { fields.append(el("h3", "su-group", spec.group)); lastGroup = spec.group; }
    const row = el("div", "su-field");
    const id = `su-${spec.key}`;
    const label = el("label", "su-label", spec.label); label.htmlFor = id;
    let control: HTMLInputElement | HTMLSelectElement;
    if (spec.kind === "zone") {
      const s = el("select", "su-input");
      for (const [v, t] of Object.entries(ZONE_LABELS)) { const o = el("option", undefined, t); o.value = v; s.append(o); }
      control = s;
    } else {
      const i = el("input", "su-input su-num");
      i.type = "text"; i.inputMode = spec.kind === "integer" ? "numeric" : "decimal"; i.autocomplete = "off"; i.spellcheck = false;
      control = i;
    }
    control.id = id; control.dataset.testid = `input-${spec.key}`;
    const errId = `${id}-err`, hintId = `${id}-hint`;
    control.setAttribute("aria-describedby", `${hintId} ${errId}`);
    const hint = el("span", "su-hint", rangeText(spec)); hint.id = hintId;
    const err = el("p", "su-error"); err.id = errId; err.dataset.testid = `error-${spec.key}`;
    const line = el("div", "su-line"); line.append(control, hint);
    row.append(label, line);
    if (options.overridden[spec.key]) row.append(el("p", "su-override", "URL の指定で上書き中"));
    row.append(err);
    fields.append(row);
    controls.set(spec.key, control); errorEls.set(spec.key, err);
    control.addEventListener("input", () => { form.set(spec.key, control.value); render(false); });
  }

  function render(syncInputs: boolean) {
    const errors = form.errors();
    const usable = form.status === "ready" || form.status === "saving";
    panel.dataset.status = form.status;
    for (const spec of FIELD_SPECS) {
      const c = controls.get(spec.key)!, e = errorEls.get(spec.key)!;
      if (syncInputs) c.value = form.inputs[spec.key];
      c.disabled = !usable || form.status === "saving";
      const msg = usable ? errors[spec.key] ?? "" : "";
      e.textContent = msg; c.toggleAttribute("aria-invalid", !!msg);
    }
    notice.textContent = form.status === "loading" ? "最新の設定を読み込み中…" : form.status === "saving" ? "保存中…" : form.message;
    notice.dataset.tone = form.status === "load-error" || (form.status === "ready" && form.message) ? "error" : "info";
    saveBtn.disabled = !form.canSave();
    saveBtn.textContent = form.status === "saving" ? "保存中…" : "保存";
    defaultsBtn.disabled = form.status !== "ready";
  }

  async function doOpen() {
    if (destroyed) return;
    const gen = ++generation;
    form.begin(); render(true);
    if (!open) { open = true; dialog.showModal(); options.onModalChange?.(true); }
    try {
      const doc = await options.load();
      if (gen !== generation || !open) return;
      form.loadOk(doc.values);
    } catch (e) {
      if (gen !== generation || !open) return;
      form.loadFail(reason(e));
    }
    render(true);
  }

  function doClose() {
    generation++;
    if (!open) return;
    open = false;
    if (dialog.open) dialog.close();
    form.begin();
    options.onModalChange?.(false);
    settingsBtn.focus({ preventScroll: true });
  }

  async function doSave() {
    const values = form.startSave();
    if (!values) return;
    const gen = generation;
    render(false);
    try {
      const doc = await options.save(values);
      if (destroyed) return;
      options.onSaved(doc);
      if (gen === generation && open) doClose();
    } catch (e) {
      if (gen !== generation || !open) return;
      form.saveFail(reason(e)); render(false);
    }
  }

  const onSettings = () => { void doOpen(); };
  const onReset = () => options.onReset();
  const onSubmit = (e: Event) => { e.preventDefault(); void doSave(); };
  const onDefaults = () => { form.resetDefaults(); render(true); };
  const onCancel = (e: Event) => { e.preventDefault(); doClose(); };
  const onBackdrop = (e: MouseEvent) => { if (e.target === dialog) doClose(); };
  settingsBtn.addEventListener("click", onSettings);
  resetBtn.addEventListener("click", onReset);
  body.addEventListener("submit", onSubmit);
  defaultsBtn.addEventListener("click", onDefaults);
  closeBtn.addEventListener("click", doClose);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("click", onBackdrop);
  render(true);

  return {
    isOpen: () => open,
    open: doOpen,
    close: doClose,
    destroy: () => {
      if (destroyed) return;
      doClose(); destroyed = true;
      settingsBtn.removeEventListener("click", onSettings);
      resetBtn.removeEventListener("click", onReset);
      dialog.remove(); rail.replaceChildren(); rail.classList.remove("su-rail");
    },
  };
}
