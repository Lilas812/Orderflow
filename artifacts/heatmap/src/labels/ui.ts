import "./labels.css";
import { initialFailedDirection, utcDayRange, mustConfirmRevision } from "./pure.ts";
export { initialFailedDirection, utcDayRange };
import type { MarketSymbol } from "../../../../lib/market/instruments.ts";
import { labelContext, NOTE_LIMIT, validDraft } from "../../../../lib/market/labels.ts";
import type { LabelDraft, LabelKind, LabelsDocument, TurningLabel } from "../../../../lib/market/labels.ts";

export interface LabelsUiOptions {
  symbol: MarketSymbol;
  screen: "heatmap" | "footprint";
  rail: HTMLElement;
  workspace: HTMLElement;
  canvas: HTMLCanvasElement;
  point(x: number, y: number): { tsSec: number; priceTicks: number } | null;
  project(label: TurningLabel): { x: number; y: number } | null;
  context(): { referenceUs: number; replay: boolean; follow: boolean };
  approach(tsSec: number): "up" | "down" | null;
}

export const LABEL_COLORS = { top: "#ff7474", bottom: "#61b5ff", failed: "#ffc857" } as const;
export const MARK_SIZE = 12;
const base = () => { try { return import.meta.env.BASE_URL ?? "/"; } catch { return "/"; } };
const api = (p: string) => `${base()}api/${p}`;

export function validDocument(v: unknown): v is LabelsDocument {
  const d = v as LabelsDocument;
  return !!d && d.version === 1 && typeof d.generation === "string" && Array.isArray(d.labels)
    && d.labels.every(l => validDraft(l) && Number.isFinite(l.createdUs) && Number.isFinite(l.updatedUs));
}

export function drawMark(ctx: CanvasRenderingContext2D, kind: LabelKind, x: number, y: number) {
  const h = MARK_SIZE / 2;
  ctx.strokeStyle = ctx.fillStyle = LABEL_COLORS[kind]; ctx.lineWidth = 2.5;
  ctx.beginPath();
  if (kind === "top") { ctx.moveTo(x - h, y - h); ctx.lineTo(x + h, y - h); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill(); }
  else if (kind === "bottom") { ctx.moveTo(x - h, y + h); ctx.lineTo(x + h, y + h); ctx.lineTo(x, y - h); ctx.closePath(); ctx.fill(); }
  else { ctx.moveTo(x - h, y - h); ctx.lineTo(x + h, y + h); ctx.moveTo(x + h, y - h); ctx.lineTo(x - h, y + h); ctx.stroke(); }
}

const KIND_JA: Record<LabelKind, string> = { top: "天井", bottom: "底", failed: "抜けた" };
const VIEW_JA = { live: "ライブ", blind: "未来非表示", hindsight: "後知恵（未来が見えていた）" } as const;
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function mountLabelsUi(o: LabelsUiOptions) {
  let doc: LabelsDocument | null = null, readable = false, armed = false, busy = false, destroyed = false;
  let uncertain = false; // after 503: must reread before retry
  let editing: { label: LabelDraft; existing: TurningLabel | null; base?: number; consent?: number } | null = null;
  const ac = new AbortController();

  const mk = (cls: string, label: string, svg: string) => {
    const b = document.createElement("button"); b.type = "button"; b.className = cls;
    b.title = label; b.setAttribute("aria-label", label); b.innerHTML = svg; o.rail.append(b); return b;
  };
  const markBtn = mk("labels-tool", "転換点をマーク", '<svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="M6 5h12l-6 9z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 14v6" stroke="currentColor" stroke-width="1.5"/></svg>');
  markBtn.setAttribute("aria-pressed", "false");
  const exportBtn = mk("labels-tool", "特徴データを書き出す", '<svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 19h14" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>');

  const overlay = document.createElement("canvas"); overlay.className = "labels-overlay"; overlay.setAttribute("aria-hidden", "true");
  const hits = document.createElement("div"); hits.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:13";
  const parent = o.canvas.parentElement!; parent.append(overlay, hits);
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

  // Editor dialog
  const dlg = document.createElement("dialog"); dlg.className = "labels-dialog"; dlg.setAttribute("aria-label", "転換点マーク");
  dlg.innerHTML = `<h2></h2><form method="dialog">
    <div class="labels-meta" data-role="meta"></div>
    <fieldset><legend>種類</legend>${(["top", "bottom", "failed"] as const).map(k => `<label><input type="radio" name="kind" value="${k}" aria-label="${KIND_JA[k]}">${KIND_JA[k]}</label>`).join("")}</fieldset>
    <fieldset data-role="dir"><legend>抜けた方向の意図（必須）</legend><label><input type="radio" name="dir" value="down" aria-label="天井のつもり">天井のつもり</label><label><input type="radio" name="dir" value="up" aria-label="底のつもり">底のつもり</label></fieldset>
    <label>確信度 <select name="conf" aria-label="確信度"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label>
    <label style="flex-direction:column;align-items:stretch">メモ（任意・${NOTE_LIMIT}文字まで）<textarea name="note" aria-label="メモ"></textarea><span data-role="count"></span></label>
    <span role="status"></span><span role="alert"></span>
    <div class="labels-row"><button type="button" data-action="delete">削除</button><button type="button" data-action="reload">再読込</button><button type="button" data-action="cancel">閉じる</button><button type="submit" data-action="save">保存</button></div>
  </form>`;
  const exp = document.createElement("dialog"); exp.className = "labels-dialog"; exp.setAttribute("aria-label", "特徴データの書き出し");
  const today = new Date().toISOString().slice(0, 10);
  exp.innerHTML = `<h2>特徴データの書き出し（ZIP）</h2><form method="dialog">
    <div class="labels-meta">日付はUTC（協定世界時）の日単位で、開始日と終了日を含みます。ZIPには派生した特徴量のみが含まれます。</div>
    <label>銘柄 <select name="sym" aria-label="書き出す銘柄"><option>NQ</option><option>GC</option></select></label>
    <label>開始日（UTC） <input type="date" name="from" aria-label="開始日（UTC）" required value="${today}"></label>
    <label>終了日（UTC） <input type="date" name="to" aria-label="終了日（UTC）" required value="${today}"></label>
    <span role="status"></span><span role="alert"></span>
    <div class="labels-row"><button type="button" data-action="cancel">閉じる</button><button type="submit">書き出す</button></div></form>`;
  document.body.append(dlg, exp);
  (exp.querySelector('[name="sym"]') as HTMLSelectElement).value = o.symbol;

  const q = <T extends HTMLElement>(root: HTMLElement, s: string) => root.querySelector<T>(s)!;
  const form = q<HTMLFormElement>(dlg, "form"), alertEl = q(dlg, "[role=alert]"), statusEl = q(dlg, "[role=status]");
  const note = q<HTMLTextAreaElement>(dlg, "textarea"), conf = q<HTMLSelectElement>(dlg, "select");
  const dirSet = q<HTMLFieldSetElement>(dlg, '[data-role="dir"]');
  const radios = (n: string) => Array.from(dlg.querySelectorAll<HTMLInputElement>(`input[name="${n}"]`));
  const radio = (n: string) => radios(n).find(r => r.checked)?.value;
  const setRadio = (n: string, v: string | null) => radios(n).forEach(r => { r.checked = r.value === v; });

  const syncForm = () => {
    const kind = radio("kind");
    dirSet.hidden = kind !== "failed";
    const len = Array.from(note.value).length;
    q(dlg, '[data-role="count"]').textContent = `${len}/${NOTE_LIMIT}`;
    const ok = !!doc && readable && !busy && !uncertain && !!kind && (kind !== "failed" || !!radio("dir")) && len <= NOTE_LIMIT;
    q<HTMLButtonElement>(dlg, '[data-action="save"]').disabled = !ok;
    const del = q<HTMLButtonElement>(dlg, '[data-action="delete"]');
    del.hidden = !editing?.existing; del.disabled = !doc || !readable || busy || uncertain;
  };
  form.addEventListener("input", syncForm);

  const hitNodes = new Map<string, HTMLButtonElement>();
  const render = () => {
    if (destroyed) return;
    const r = o.canvas.getBoundingClientRect(), pr = parent.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    Object.assign(overlay.style, { left: `${r.left - pr.left + parent.scrollLeft - parent.clientLeft}px`, top: `${r.top - pr.top + parent.scrollTop - parent.clientTop}px`, width: `${r.width}px`, height: `${r.height}px` });
    hits.style.left = overlay.style.left; hits.style.top = overlay.style.top; hits.style.width = overlay.style.width; hits.style.height = overlay.style.height; hits.style.inset = "";
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    const ctx = overlay.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
    const seen = new Set<string>();
    for (const l of doc?.labels ?? []) {
      if (l.symbol !== o.symbol) continue;
      const p = o.project(l); if (!p || p.x < -8 || p.y < -8 || p.x > r.width + 8 || p.y > r.height + 8) continue;
      drawMark(ctx, l.kind, p.x, p.y);
      seen.add(l.id);
      let b = hitNodes.get(l.id);
      if (!b) {
        b = document.createElement("button"); b.type = "button"; b.className = "labels-hit";
        const id = l.id;
        b.onclick = e => { e.stopPropagation(); const cur = doc?.labels.find(x => x.id === id); if (cur) openEditor({ ...cur }, cur); };
        hitNodes.set(id, b); hits.append(b);
      }
      b.style.left = `${p.x}px`; b.style.top = `${p.y}px`;
      b.setAttribute("aria-label", `${KIND_JA[l.kind]}マークを編集`);
    }
    for (const [id, b] of hitNodes) if (!seen.has(id)) { b.remove(); hitNodes.delete(id); }
    markBtn.disabled = !doc || !readable; if (!readable) armed = false; markBtn.setAttribute("aria-pressed", String(armed));
    o.canvas.classList.toggle("labels-armed", armed);
  };

  const load = async () => {
    try {
      const res = await fetch(api(`labels?symbol=${o.symbol}`), { cache: "no-store", credentials: "include", signal: ac.signal });
      if (!res.ok) throw new Error(String(res.status));
      const d: unknown = await res.json(); if (!validDocument(d)) throw new Error("invalid");
      doc = d; readable = true; uncertain = false; markBtn.title = "転換点をマーク"; render(); return true;
    } catch (e) {
      if (!destroyed && (e as Error).name !== "AbortError") { readable = false; markBtn.title = "マークの読込に失敗しました（編集不可）"; render(); }
      return false;
    } finally { syncForm(); }
  };

  const fill = (l: LabelDraft) => {
    setRadio("kind", l.kind); setRadio("dir", l.kind === "failed" ? l.expectedDirection : null);
    conf.value = String(l.confidence); note.value = l.note;
  };
  const meta = (l: LabelDraft) => {
    const t = new Date(l.tsSec * 1000).toISOString().replace("T", " ").slice(0, 19);
    q(dlg, '[data-role="meta"]').innerHTML = `時刻 ${esc(t)} UTC ／ 価格ティック ${l.priceTicks}<br>表示状態 ${esc(VIEW_JA[l.viewMode])} ／ 受信済み／再生位置より前の秒数 ${l.futureSeconds.toFixed(1)}秒<br><small>マーク時点で受信済み（リプレイでは再生位置まで）の未来の秒数です。画面に見えていたか、あなたが事前に知っていたかの記録ではありません。</small>`;
  };
  const openEditor = (draft: LabelDraft, existing: TurningLabel | null, failedDir?: "up" | "down" | null) => {
    editing = { label: draft, existing, base: existing?.updatedUs };
    q(dlg, "h2").textContent = existing ? "マークを編集" : "マークを追加";
    alertEl.textContent = ""; statusEl.textContent = ""; meta(draft); fill(draft);
    if (!existing) { setRadio("kind", null); if (failedDir !== undefined) setRadio("dir", failedDir); }
    syncForm(); if (!dlg.open) dlg.showModal(); void load();
  };

  const readForm = (): LabelDraft | null => {
    if (!editing) return null;
    const kind = radio("kind") as LabelKind | undefined; if (!kind) return null;
    const expectedDirection = kind === "top" ? "down" : kind === "bottom" ? "up" : radio("dir") as "up" | "down" | undefined;
    if (!expectedDirection) return null;
    const d: LabelDraft = { ...editing.label, kind, expectedDirection, confidence: Number(conf.value), note: note.value };
    return validDraft(d) ? d : null;
  };

  const mutate = async (method: "POST" | "PUT" | "DELETE", body: unknown) => {
    busy = true; alertEl.textContent = ""; statusEl.textContent = "保存中…"; syncForm();
    try {
      const res = await fetch(api("labels"), { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
      if (res.ok) {
        const d: unknown = await res.json().catch(() => null);
        if (!validDocument(d)) { uncertain = true; statusEl.textContent = ""; alertEl.textContent = "応答が不正です。保存されたか不明です。再読込してください。"; return false; }
        doc = d; render(); return true;
      }
      statusEl.textContent = "";
      if (res.status === 409) { await load(); if (editing) editing.consent = doc?.labels.find(l => l.id === editing!.label.id)?.updatedUs; alertEl.textContent = "他の画面で更新されていました（競合）。最新を読み込みました。入力内容は残しています。確認して再度保存してください。"; }
      else if (res.status === 404) { await load(); alertEl.textContent = "このマークは既に存在しません。"; }
      else if (res.status === 400) alertEl.textContent = "入力内容が不正です。";
      else { uncertain = true; alertEl.textContent = `保存結果が不明です（${res.status}）。入力は残しています。「再読込」で確認してから再試行してください。`; }
      return false;
    } catch (e) {
      if ((e as Error).name === "AbortError") return false;
      uncertain = true; statusEl.textContent = ""; alertEl.textContent = "通信エラー：保存されたか不明です。「再読込」で確認してから再試行してください。"; return false;
    } finally { busy = false; syncForm(); }
  };

  form.onsubmit = async e => {
    e.preventDefault(); if (!doc || busy || uncertain || !editing) return;
    const d = readForm(); if (!d) { alertEl.textContent = "種類（抜けたの場合は意図）を選んでください。"; return; }
    const exists = doc.labels.find(l => l.id === d.id);
    // Same ID already present (e.g. earlier POST succeeded) -> update instead of duplicating.
    if (!readable) return;
    const put = !!(exists || editing.existing);
    if (put && editing.existing && !exists) { alertEl.textContent = "このマークは既に存在しません。"; return; }
    if (exists && mustConfirmRevision(editing.base, editing.consent, exists.updatedUs)) {
      editing.consent = exists.updatedUs;
      alertEl.textContent = "他の画面で更新されています（競合）。入力内容で上書きする場合はもう一度「保存」を押してください。"; return;
    }
    const updatedUs = exists?.updatedUs ?? editing.existing?.updatedUs;
    const ok = await mutate(put ? "PUT" : "POST", { label: put ? { ...d, updatedUs } : d, generation: doc.generation });
    if (ok) { statusEl.textContent = "保存しました"; editing.existing = doc.labels.find(l => l.id === d.id) ?? null; dlg.close(); }
  };
  q<HTMLButtonElement>(dlg, '[data-action="delete"]').onclick = async () => {
    const cur = editing && doc?.labels.find(l => l.id === editing!.label.id);
    if (!doc || !cur || !editing) return;
    if (mustConfirmRevision(editing.base, editing.consent, cur.updatedUs)) {
      editing.consent = cur.updatedUs;
      alertEl.textContent = "他の画面で更新されています（競合）。削除する場合はもう一度「削除」を押して確認してください。"; return;
    }
    if (!confirm("このマークを削除しますか？")) return;
    if (await mutate("DELETE", { symbol: cur.symbol, id: cur.id, generation: doc.generation, updatedUs: cur.updatedUs })) dlg.close();
  };
  q<HTMLButtonElement>(dlg, '[data-action="reload"]').onclick = async () => {
    statusEl.textContent = "再読込中…";
    const ok = await load();
    statusEl.textContent = ok ? (editing && doc?.labels.some(l => l.id === editing!.label.id) ? "再読込しました：このマークは保存済みです。" : "再読込しました：このマークは未保存です。") : "";
    if (!ok) alertEl.textContent = "読込に失敗しました。";
    else alertEl.textContent = "";
  };
  q<HTMLButtonElement>(dlg, '[data-action="cancel"]').onclick = () => dlg.close();
  dlg.addEventListener("close", () => { editing = null; });

  // Placement: click only (no drag, no multi-touch)
  let down: { id: number; x: number; y: number } | null = null, multi = false;
  const pointers = new Set<number>();
  const onDown = (e: PointerEvent) => {
    pointers.add(e.pointerId); if (!armed) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (pointers.size > 1) multi = true; down = multi ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId); if (!armed) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const d = down; down = null;
    const wasMulti = multi; if (pointers.size === 0) multi = false;
    if (wasMulti) return;
    if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    place(e.clientX, e.clientY);
  };
  const onCancel = (e: PointerEvent) => { pointers.delete(e.pointerId); down = null; if (pointers.size === 0) multi = false; };
  const block = (e: Event) => { if (armed) { e.preventDefault(); e.stopImmediatePropagation(); } };
  o.canvas.addEventListener("pointerdown", onDown, true);
  o.canvas.addEventListener("pointerup", onUp, true);
  o.canvas.addEventListener("pointercancel", onCancel, true);
  for (const t of ["pointermove", "click", "wheel", "touchstart", "touchmove"]) o.canvas.addEventListener(t, block, { capture: true, passive: false });

  const place = (cx: number, cy: number) => {
    if (!doc || !readable) return;
    const r = o.canvas.getBoundingClientRect(), p = o.point(cx - r.left, cy - r.top);
    if (!p || !Number.isSafeInteger(p.tsSec) || !Number.isSafeInteger(p.priceTicks) || p.priceTicks <= 0) return;
    const c = o.context(), ctx = labelContext(p.tsSec, c.referenceUs, c.replay, c.follow);
    armed = false; render();
    const draft: LabelDraft = { id: crypto.randomUUID(), symbol: o.symbol, tsSec: p.tsSec, priceTicks: p.priceTicks,
      kind: "top", confidence: 2, note: "", viewMode: ctx.viewMode, screen: o.screen, expectedDirection: "down", futureSeconds: ctx.futureSeconds };
    openEditor(draft, null, initialFailedDirection(o.approach(p.tsSec)));
  };

  markBtn.onclick = () => { if (!doc || !readable) return; armed = !armed; render(); };
  const onKey = (e: KeyboardEvent) => { if (armed && e.key === "Escape") { armed = false; render(); } };
  addEventListener("keydown", onKey);

  // Export
  const expForm = q<HTMLFormElement>(exp, "form"), expAlert = q(exp, "[role=alert]"), expStatus = q(exp, "[role=status]");
  const expSubmit = q<HTMLButtonElement>(exp, 'button[type="submit"]');
  exportBtn.onclick = () => { expAlert.textContent = ""; expStatus.textContent = ""; exp.showModal(); };
  q<HTMLButtonElement>(exp, '[data-action="cancel"]').onclick = () => exp.close();
  expForm.onsubmit = async e => {
    e.preventDefault();
    const sym = (q<HTMLSelectElement>(exp, '[name="sym"]').value) as MarketSymbol;
    const range = utcDayRange(q<HTMLInputElement>(exp, '[name="from"]').value, q<HTMLInputElement>(exp, '[name="to"]').value);
    if (!range) { expAlert.textContent = "日付範囲が不正です（終了日は開始日以降）。"; return; }
    expAlert.textContent = ""; expStatus.textContent = "書き出し中…"; expSubmit.disabled = true;
    try {
      const res = await fetch(api(`labels/export?symbol=${sym}&fromSec=${range.fromSec}&toSec=${range.toSec}`), { credentials: "include", cache: "no-store", signal: ac.signal });
      if (!res.ok) throw new Error(res.status === 400 ? "指定範囲が不正です。" : res.status === 409 ? "別の書き出しが実行中です。しばらくして再試行してください。" : `書き出しに失敗しました（${res.status}）。`);
      if (!(res.headers.get("content-type") ?? "").includes("application/zip")) throw new Error("ZIP以外の応答を受け取りました。");
      const blob = await res.blob(), url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `labels-${sym}-${new Date(range.fromSec * 1000).toISOString().slice(0, 10)}_${new Date((range.toSec - 86400) * 1000).toISOString().slice(0, 10)}.zip`;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      expStatus.textContent = "書き出しました。";
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      expStatus.textContent = ""; expAlert.textContent = err instanceof TypeError ? "通信エラーで書き出せませんでした。" : (err as Error).message;
    } finally { expSubmit.disabled = false; }
  };

  const ro = new ResizeObserver(() => render()); ro.observe(o.canvas);
  // Read-only refresh while visible; never writes.
  const poll = setInterval(() => { if (document.visibilityState === "visible" && !busy) void load(); }, 30_000);
  void load(); render();

  return {
    render,
    destroy() {
      destroyed = true; ac.abort(); clearInterval(poll); ro.disconnect(); removeEventListener("keydown", onKey);
      o.canvas.removeEventListener("pointerdown", onDown, true); o.canvas.removeEventListener("pointerup", onUp, true);
      o.canvas.removeEventListener("pointercancel", onCancel, true);
      for (const t of ["pointermove", "click", "wheel", "touchstart", "touchmove"]) o.canvas.removeEventListener(t, block, true);
      o.canvas.classList.remove("labels-armed");
      markBtn.remove(); exportBtn.remove(); overlay.remove(); hits.remove(); dlg.remove(); exp.remove();
    },
  };
}
