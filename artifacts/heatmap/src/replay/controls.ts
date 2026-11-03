import "./replay.css";
import { localCandidates, localDateTime, replayPreferences } from "./time.ts";
import type { HelloMessage, RealtimeClient } from "../data/socket.ts";
import type { DisplayZone } from "../chart/timezone.ts";
import { clearSharedReplay, saveSharedReplay } from "./shared.ts";
import type { MarketSymbol } from "../../../../lib/market/instruments.ts";

type ReplayTransport = Pick<RealtimeClient, "startReplay" | "returnLive" | "replayControl">;
export function mountReplayControls(host: HTMLElement, rail: HTMLElement, canvas: HTMLCanvasElement,
  client: ReplayTransport, zone: () => DisplayZone, pickTime: (x: number) => number, reset: () => void,
  symbol: MarketSymbol) {
  const prefs = replayPreferences();
  let hello: HelloMessage | null = null, active = false, selecting = false, state = "paused", position = 0, controlled = false;
  const button = document.createElement("button");
  button.className = "replay-tool"; button.type = "button"; button.title = "リプレイ"; button.setAttribute("aria-label", "リプレイ");
  button.innerHTML = '<svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m11 8 6 4-6 4z" fill="currentColor"/></svg>';
  rail.append(button);
  const bar = document.createElement("section");
  bar.className = "replay-bar"; bar.hidden = true; bar.setAttribute("aria-label", "リプレイ操作");
  bar.innerHTML = `<strong data-role="clock"></strong><span data-role="selecting"></span>
    <button type="button" data-action="play">再生</button>
    <label>速度 <select aria-label="リプレイ速度">${[1,2,5,10,30,60].map(n => `<option value="${n}">${n}倍</option>`).join("")}</select></label>
    <label>コマ幅 <select aria-label="コマ送り幅"><option value="1">1秒</option><option value="10">10秒</option><option value="60">1分</option></select></label>
    <button type="button" data-action="step">コマ送り</button><button type="button" data-action="pick">チャートでジャンプ</button>
    <form><label data-role="zone"></label><input type="datetime-local" step="1" aria-label="リプレイ日時" required>
    <select data-role="offset" aria-label="夏時間の重複時刻" hidden></select><button type="submit">日時へ移動</button></form>
    <button type="button" data-action="live">ライブに戻る</button><span role="alert"></span>`;
  host.append(bar);
  const find = <T extends HTMLElement>(s: string) => bar.querySelector<T>(s)!;
  const clock = find('[data-role="clock"]'), hint = find('[data-role="selecting"]'), error = find('[role="alert"]');
  const date = find<HTMLInputElement>("input"), speed = find<HTMLSelectElement>('[aria-label="リプレイ速度"]');
  const step = find<HTMLSelectElement>('[aria-label="コマ送り幅"]'), offset = find<HTMLSelectElement>('[data-role="offset"]');
  speed.value = String(prefs.speed); step.value = String(prefs.step);
  const line = document.createElement("div"); line.className = "replay-pick-line"; line.hidden = true;
  const label = document.createElement("span"); line.append(label); canvas.parentElement!.append(line);
  const showError = (message: string) => { error.textContent = message; bar.hidden = false; };
  const render = () => {
    bar.hidden = !active && !selecting;
    hint.textContent = selecting ? `${active ? "ジャンプ" : "開始"}位置をチャートで選択、または日時を入力` : "";
    clock.textContent = active ? `リプレイ${state === "ended" ? "：保存データの終わり" : state === "paused" ? " 一時停止" : state === "loading" ? " 読込中" : " 再生中"} ${localDateTime(position / 1e6, zone()).replace("T", " ")}` : "リプレイ開始位置";
    find('[data-role="zone"]').textContent = zone() === "jst" ? "日本時間" : "米国中部時間（CT）";
    const play = find<HTMLButtonElement>('[data-action="play"]'); play.textContent = state === "playing" ? "一時停止" : "再生";
    play.disabled = !active || !controlled || ["loading","ended","error"].includes(state);
    find<HTMLButtonElement>('[data-action="step"]').disabled = !active || !controlled || state !== "paused";
    speed.disabled = active && !controlled;
    canvas.classList.toggle("replay-selecting", selecting); host.classList.toggle("replay-open", active || selecting);
    if (!selecting) line.hidden = true;
  };
  const choose = (sec: number) => {
    const saved = hello?.savedRange;
    if (!saved || !Number.isSafeInteger(sec) || sec < saved.fromSec || sec >= saved.toSec) return showError("保存範囲外です。保存済みの日時を選んでください。");
    error.textContent = ""; selecting = false;
    if (active && controlled) client.replayControl("seek", sec);
    else { active = true; state = "loading"; position = sec * 1e6; client.startReplay(sec, Number(speed.value), true, position); }
    reset(); render();
  };
  button.onclick = () => {
    selecting = !selecting; error.textContent = "";
    if (active && state === "playing") client.replayControl("pause");
    if (hello?.savedRange) date.value = localDateTime(active ? position / 1e6 : Math.max(hello.savedRange.fromSec, hello.savedRange.toSec - 1800), zone());
    render();
  };
  find('[data-action="pick"]').onclick = () => { selecting = true; if (state === "playing") client.replayControl("pause"); render(); };
  find('[data-action="play"]').onclick = () => client.replayControl(state === "playing" ? "pause" : "resume");
  find('[data-action="step"]').onclick = () => client.replayControl("step", Number(step.value));
  for (const [select, key] of [[speed, "speed"], [step, "step"]] as const) select.onchange = () => {
    try { sessionStorage.setItem("replay." + key, select.value); } catch { /* tab preferences are optional */ }
    if (key === "speed" && active) client.replayControl("speed", Number(select.value));
  };
  find('[data-action="live"]').onclick = () => {
    active = selecting = controlled = false; error.textContent = "";
    const cleared = clearSharedReplay(symbol);
    client.returnLive(); reset(); render();
    if (!cleared) showError("タブ内のリプレイ状態を消去できませんでした。画面切替後に再開する可能性があります。");
    const u = new URL(location.href); for (const k of ["mode","from","speed","controls","paused","headUs"]) u.searchParams.delete(k); history.replaceState(null, "", u);
  };
  date.oninput = () => { offset.hidden = true; offset.innerHTML = ""; };
  find<HTMLFormElement>("form").onsubmit = e => {
    e.preventDefault(); const choices = localCandidates(date.value, zone());
    if (!choices.length) return showError("存在しない日時です。夏時間の切り替えも確認してください。");
    if (choices.length > 1 && !choices.some(c => String(c.sec) === offset.value)) {
      offset.innerHTML = '<option value="">夏時間／標準時間を選択</option>' + choices.map(c => `<option value="${c.sec}">${c.offset}</option>`).join("");
      offset.hidden = false; return showError("この時刻は2回あります。UTC差を選んでください。");
    }
    choose(choices.length === 1 ? choices[0]!.sec : Number(offset.value));
  };
  const move = (e: PointerEvent) => {
    if (!selecting) return;
    const r = canvas.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    line.hidden = false; line.style.left = `${x}px`; label.textContent = localDateTime(pickTime(x), zone()).replace("T", " ");
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerdown", e => { if (selecting) { e.preventDefault(); e.stopImmediatePropagation(); move(e); } }, true);
  canvas.addEventListener("pointerup", e => {
    if (!selecting) return; e.preventDefault(); e.stopImmediatePropagation();
    choose(pickTime(e.clientX - canvas.getBoundingClientRect().left));
  }, true);
  return {
    hello(h: HelloMessage) {
      hello = h; active = h.mode === "replay"; controlled = !!h.replayControlled;
      if (active) { position = h.replayHeadUs ?? (h.replayFromSec ?? 0) * 1e6; state = "loading"; date.value = localDateTime(position/1e6,zone()); }
      if (active && !controlled) showError("旧サーバー：操作付きリプレイ非対応。サーバーも更新してください。");
      render();
    },
    state(s: Record<string, unknown>) {
      active = true; state = String(s.state); position = Number(s.positionUs); speed.value = String(s.speed);
      if (["playing", "paused", "ended"].includes(state) && Number.isSafeInteger(position)) {
        const fromSec = Number(s.fromSec ?? Math.floor(position / 1e6));
        const toSec = Number(s.toSec ?? hello?.savedRange?.toSec);
        if (Number.isSafeInteger(fromSec) && Number.isSafeInteger(toSec) && fromSec < toSec
          && position >= fromSec * 1e6 && position <= toSec * 1e6
          && !saveSharedReplay({ symbol, positionUs: position, fromSec, toSec, state: state as "playing" | "paused" | "ended", speed: Number(speed.value) })) {
          showError("タブ内に再生位置を保存できませんでした。画面を切り替えると位置を引き継げない可能性があります。");
        }
      }
      render();
    },
    persistForNavigation(headUs?: number | null) {
      if (!active || !hello?.savedRange || !["playing", "paused", "ended"].includes(state)) return;
      const positionUs = Number.isSafeInteger(headUs) ? headUs! : position;
      const fromSec = Math.min(hello.savedRange.toSec - 1, Math.floor(positionUs / 1e6));
      if (!Number.isSafeInteger(positionUs) || positionUs < fromSec * 1e6
        || positionUs > hello.savedRange.toSec * 1e6) return;
      if (!saveSharedReplay({ symbol, positionUs, fromSec, toSec: hello.savedRange.toSec,
        state: state as "playing" | "paused" | "ended", speed: Number(speed.value) })) {
        showError("タブ内に再生位置を保存できませんでした。画面を切り替えると位置を引き継げない可能性があります。");
      }
    },
    error(code: string) {
      const messages: Record<string,string> = { replay_no_saved_data: "指定秒に保存データがありません。別の位置を選んでください。", replay_limit: "同時リプレイはサーバー全体で2つまでです。", replay_loading: "リプレイ読込中です。" };
      if (code.startsWith("replay_")) showError(messages[code] ?? code);
    },
    refresh: () => { if (active) date.value = localDateTime(position/1e6,zone()); render(); },
  };
}
