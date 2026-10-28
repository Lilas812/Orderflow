import { parseDay, parseRolls, type DayData, type RollData } from "./model.ts";
import { tradingDatesBetween } from "./time.ts";

export const MAX_DAYS_PER_CALL = 60;
export const MAX_CACHED_DAYS = 160;

type Entry = DayData | "missing";

/** Splits sorted trading dates into contiguous runs of at most `max` trading days. */
export function planRequests(missing: string[], max = MAX_DAYS_PER_CALL): { from: string; to: string; dates: string[] }[] {
  const out: { from: string; to: string; dates: string[] }[] = [];
  for (const date of missing) {
    const last = out.at(-1);
    const contiguous = last && tradingDatesBetween(last.to, date).length === 2;
    if (last && contiguous && last.dates.length < max) { last.dates.push(date); last.to = date; }
    else out.push({ from: date, to: date, dates: [date] });
  }
  return out;
}
/** Evicts dates farthest from [from,to] until the cache fits. Returns evicted dates. */
export function evictionOrder(cached: string[], from: string, to: string, max = MAX_CACHED_DAYS): string[] {
  if (cached.length <= max) return [];
  const dist = (d: string) => d < from ? Date.parse(from) - Date.parse(d) : d > to ? Date.parse(d) - Date.parse(to) : 0;
  return cached.slice().sort((a, b) => dist(b) - dist(a)).slice(0, cached.length - max).filter(d => dist(d) > 0);
}

async function getJson(path: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`, { cache: "no-store", credentials: "include", signal });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok && res.status !== 503) {
    const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw Error(msg);
  }
  return { status: res.status, body };
}

export type LoadState = "idle" | "loading" | "error" | "disabled";

export class LongVpStore {
  private days = new Map<string, Entry>();
  private controller: AbortController | null = null;
  private pendingKey = "";
  private todayController: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  rolls: RollData[] = [];
  rollsState: LoadState = "idle"; rollsError = "";
  today: DayData | null = null;
  todayState: LoadState = "idle"; todayError = "";
  daysState: LoadState = "idle"; daysError = "";
  revision = 0;
  private wanted: string[] = [];
  private destroyed = false;
  private rollsController: AbortController | null = null;
  private onChange: () => void;
  constructor(onChange: () => void) { this.onChange = onChange; }

  start() {
    void this.loadRolls(); void this.pollToday();
    this.timer = setInterval(() => void this.pollToday(), 60_000);
  }
  destroy() {
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.controller?.abort(); this.todayController?.abort(); this.rollsController?.abort();
    this.days.clear();
  }
  private changed() { this.revision++; if (!this.destroyed) this.onChange(); }

  async loadRolls() {
    this.rollsState = "loading"; this.changed();
    this.rollsController?.abort();
    const c = new AbortController(), timer = setTimeout(() => c.abort(), 15000);
    this.rollsController = c;
    try {
      const r = await getJson("api/longvp/rolls", c.signal);
      if (this.destroyed) return;
      if (r.status === 503) { this.rollsState = "disabled"; this.rollsError = "長期VPは無効です"; }
      else { this.rolls = parseRolls(r.body); this.rollsState = "idle"; this.rollsError = ""; }
    } catch (e) {
      if (this.destroyed || c !== this.rollsController) return;
      this.rollsState = "error"; this.rollsError = c.signal.aborted ? "乗り換え記録の取得がタイムアウトしました" : message(e);
    } finally { clearTimeout(timer); }
    this.changed();
  }
  async pollToday() {
    if (this.destroyed) return;
    this.todayController?.abort();
    const c = new AbortController(); this.todayController = c;
    const timer = setTimeout(() => c.abort(), 15000);
    if (!this.today) { this.todayState = "loading"; this.changed(); }
    try {
      const r = await getJson("api/longvp/today", c.signal);
      if (c !== this.todayController) return;
      if (r.status === 503) { this.todayState = "disabled"; this.todayError = "当日分は準備中か無効です（503）"; this.today = null; }
      else {
        const next = parseDay(r.body);
        if (this.today && this.today.tradingDate !== next.tradingDate) this.days.delete(this.today.tradingDate);
        this.today = next; this.todayState = "idle"; this.todayError = "";
      }
    } catch (e) {
      if (c !== this.todayController) return;
      this.todayState = "error"; this.todayError = c.signal.aborted ? "当日分の取得がタイムアウトしました" : message(e);
    } finally { clearTimeout(timer); }
    this.changed();
  }

  /** Requests the given trading dates (excluding today's). Aborts a stale in-flight request. */
  ensure(dates: string[]) {
    this.wanted = dates;
    const missing = dates.filter(d => !this.days.has(d));
    const evict = evictionOrder([...this.days.keys()].sort(), dates[0] ?? "", dates.at(-1) ?? "");
    for (const d of evict) this.days.delete(d);
    const key = missing.join(",");
    if (missing.length === 0) {
      if (this.controller) { this.controller.abort(); this.controller = null; this.pendingKey = ""; this.daysState = "idle"; this.changed(); }
      return;
    }
    if (key === this.pendingKey && this.controller) return;
    if ((this.daysState === "error" || this.daysState === "disabled") && key === this.pendingKey) return; // wait for explicit retry
    void this.fetchMissing(missing, key);
  }
  retry() {
    for (const date of this.wanted) {
      const entry = this.days.get(date);
      if (entry === "missing" || (entry && !entry.complete)) this.days.delete(date);
    }
    this.pendingKey = ""; this.daysState = "idle"; this.ensure(this.wanted);
  }

  private async fetchMissing(missing: string[], key: string) {
    this.controller?.abort();
    const c = new AbortController(); this.controller = c; this.pendingKey = key;
    this.daysState = "loading"; this.daysError = ""; this.changed();
    let timedOut = false, timer: ReturnType<typeof setTimeout> | null = null;
    try {
      for (const plan of planRequests(missing).reverse()) {
        timer = setTimeout(() => { timedOut = true; c.abort(); }, 30000);
        const r = await getJson(`api/longvp/days?from=${plan.from}&to=${plan.to}`, c.signal);
        clearTimeout(timer); timer = null;
        if (c.signal.aborted) return;
        if (r.status === 503) { this.daysState = "disabled"; this.daysError = "長期VPは無効です（503）"; this.controller = null; this.changed(); return; }
        if (!Array.isArray(r.body)) throw Error("日次データの応答が配列ではありません");
        const got = new Set<string>();
        for (const raw of r.body) { const d = parseDay(raw); this.days.set(d.tradingDate, d); got.add(d.tradingDate); }
        for (const d of plan.dates) if (!got.has(d)) this.days.set(d, "missing");
        this.changed();
      }
      if (c === this.controller) { this.controller = null; this.daysState = "idle"; this.changed(); }
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (c !== this.controller || (c.signal.aborted && !timedOut)) return;
      this.controller = null; this.daysState = "error";
      this.daysError = timedOut ? "日次データの取得が30秒でタイムアウトしました" : message(e); this.changed();
    }
  }

  /** Loaded days among `dates`, with today's provisional day replacing its date. */
  loaded(dates: string[]): DayData[] {
    const out: DayData[] = [];
    for (const d of dates) {
      if (this.today && this.today.tradingDate === d) { out.push(this.today); continue; }
      const e = this.days.get(d);
      if (e && e !== "missing") out.push(e);
    }
    if (this.today && !dates.includes(this.today.tradingDate) && dates.length && this.today.tradingDate > dates.at(-1)!) out.push(this.today);
    return out;
  }
  missingDates(dates: string[]) { return dates.filter(d => this.days.get(d) === "missing" && this.today?.tradingDate !== d); }
  get cachedDays() { return this.days.size; }
}

function message(e: unknown) { return (e instanceof Error ? e.message : String(e)) || "不明なエラー"; }
