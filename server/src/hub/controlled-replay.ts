import { encodeFrame, parseRange } from "./frame.ts";
import { WindowedReplay } from "./windowed-replay.ts";
import type { ReplayClock } from "./replay.ts";
import type { Source } from "./hub.ts";
import { VolumeProfile } from "../vp/state.ts";
import { INSTRUMENTS, type MarketSymbol } from "../../../lib/market/instruments.ts";

/** Shared across symbols; reservation lasts for the replay connection, including pause. */
const slots = new Set<object>();
export const reserveReplay = (owner: object) => slots.has(owner) || (slots.size < 2 && !!slots.add(owner));
export const releaseReplay = (owner: object) => { slots.delete(owner); };
const speeds = [1, 2, 5, 10, 30, 60];
export class ControlledReplay {
  generation = 0;
  private engine?: WindowedReplay;
  private from = 0;
  private head = 0;
  private speed = 1;
  private state = "loading";
  private stopped = false;
  private lastStateAt = -Infinity;
  private profile?: VolumeProfile;
  private busy = false;
  private initializing: Promise<void> = Promise.resolve();
  private vpRevision?: number;
  private dailyRevision?: number;
  private profileGeneration?: number;
  private source: Source; private symbol: MarketSymbol; private clock: ReplayClock;
  private send: (data: string | Buffer) => boolean; private alive: () => boolean;
  private saved: { fromSec: number; toSec: number }; private daily: boolean;
  private buffered: () => number;
  constructor(source: Source, symbol: MarketSymbol, clock: ReplayClock,
    send: (data: string | Buffer) => boolean, alive: () => boolean,
    saved: { fromSec: number; toSec: number }, daily: boolean, buffered: () => number = () => 0) {
    this.source = source; this.symbol = symbol; this.clock = clock; this.send = send;
    this.alive = alive; this.saved = saved; this.daily = daily;
    this.buffered = buffered;
  }
  private current(g: number) { return !this.stopped && this.alive() && this.generation === g; }
  private json(value: object, g = this.generation) {
    if (this.current(g)) this.send(JSON.stringify({ ...value, replayGeneration: g, replayHeadUs: this.position }));
  }
  get position() { return this.engine?.positionUs ?? this.head; }
  private binary(data: Buffer, g: number) {
    if (!this.current(g)) return;
    const head = Buffer.alloc(13); head[0] = 4; head.writeUInt32LE(g, 1); head.writeDoubleLE(this.position, 5);
    this.send(Buffer.concat([head, data]));
  }
  private notify(force = false) {
    if (!force && this.clock.now() - this.lastStateAt < 250) return;
    this.lastStateAt = this.clock.now();
    this.json({ type: "replayState", state: this.state, positionUs: this.position,
      speed: this.speed, fromSec: this.from, toSec: this.saved.toSec });
  }
  private vp(force: boolean) {
    if (!this.profile) return;
    if (!force && this.clock.now() - this.lastStateAt < 250) return;
    if (this.profileGeneration !== this.profile.generation) {
      this.vpRevision = this.dailyRevision = undefined;
      this.profileGeneration = this.profile.generation;
    }
    if (this.vpRevision !== this.profile.revision) {
      this.json(this.profile.message(this.vpRevision)); this.vpRevision = this.profile.revision;
    }
    if (this.daily && this.dailyRevision !== this.profile.revision) {
      this.json({ ...this.profile.dailyMessage(this.dailyRevision), symbol: this.symbol }); this.dailyRevision = this.profile.revision;
    }
  }
  initialize(from: number, speed: number, paused: boolean): Promise<void> {
    if (!Number.isInteger(from) || from < this.saved.fromSec || from >= this.saved.toSec) throw Error("replay_outside_saved_range");
    this.engine?.stop(); this.engine = undefined; this.profile = undefined;
    this.vpRevision = this.dailyRevision = undefined;
    const g = ++this.generation; this.from = from; this.head = from * 1e6; this.speed = speed; this.state = "loading"; this.busy = true;
    this.json({ type: "hello", symbol: this.symbol, tickSize: INSTRUMENTS[this.symbol].tickSize, columnSeconds: 1,
      serverTimeUs: this.clock.now() * 1000, mode: "replay", savedRange: this.saved,
      replayControlled: true, replayFromSec: from });
    this.notify(true);
    this.initializing = this.initializing.catch(() => {}).then(async () => {
    if (!this.current(g)) return;
    try {
      const first = await this.source.read(from, Math.min(from + 300, this.saved.toSec));
      if (!this.current(g)) return;
      if (!first.columns.some(c => c.tsSec === from) && !first.trades.some(t => Math.floor(t.tsUs / 1e6) === from))
        throw Error("replay_no_saved_data");
      await this.range({ reqId: 0, fromSec: Math.max(0, from - 1800), toSec: from }, g);
      if (!this.current(g)) return;
      const profile = this.source.replayVp
        ? await this.source.replayVp(from, () => this.current(g))
        : new VolumeProfile(from);
      if (!this.current(g)) return;
      this.profile = profile;
      this.vp(true);
      this.engine = new WindowedReplay(first, from, this.saved.toSec, speed, (a, b) => this.source.read(a, b), {
        column: c => { this.binary(encodeFrame(1, 0, [c]), g); this.binary(encodeFrame(3, 0, [c]), g); },
        trades: trades => this.json({ type: "trades", trades }, g),
        vpTrades: trades => { if (this.current(g)) for (const t of trades) { this.profile?.advance(t.tsUs / 1e6); this.profile?.add(t); } },
        cursor: upToUs => {
          if (!this.current(g)) return;
          this.profile?.advance(upToUs / 1e6); this.vp(false); this.notify();
        },
        end: () => { if (this.current(g)) { this.state = "ended"; this.vp(true); this.notify(true); } },
        error: () => { if (this.current(g)) { this.state = "error"; this.json({ type: "error", code: "replay_read_failed" }); this.notify(true); } },
      }, this.clock, true);
      this.busy = false; this.state = paused ? "paused" : "playing";
      this.engine.start(paused); this.notify(true);
    } catch (e) {
      if (this.current(g)) {
        this.busy = false; this.state = "error";
        this.json({ type: "error", code: e instanceof Error && e.message === "replay_no_saved_data" ? e.message : "replay_read_failed" });
        this.notify(true);
      }
    }
    });
    return this.initializing;
  }
  async range(r: ReturnType<typeof parseRange>, g = this.generation) {
    // Keep the requested endpoints in rangeDone; only read the known past.
    let columns = 0, trades = 0, chunks = 0;
    const cap = this.position;
    for (let a = r.fromSec; a < r.toSec; a += 300) {
      const b = Math.min(a + 300, r.toSec), to = Math.min(b, Math.ceil(cap / 1e6));
      const view = a < to ? await this.source.read(a, to) : { columns: [], trades: [] };
      if (!this.current(g)) return;
      while (this.current(g) && this.buffered() >= 4 * 1024 * 1024)
        await new Promise<void>(r => this.clock.later(r, 50));
      if (!this.current(g)) return;
      const cs = view.columns.filter(c => c.tsSec * 1e6 < cap);
      const ts = view.trades.filter(t => t.tsUs < cap);
      this.binary(encodeFrame(2, r.reqId, cs), g); this.json({ type: "rangeTrades", reqId: r.reqId, trades: ts }, g);
      columns += cs.length; trades += ts.length; chunks++;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    this.json({ type: "rangeDone", ...r, columns, trades, chunks }, g);
  }
  async control(v: Record<string, unknown>) {
    const g = this.generation;
    if (v.op !== "replay") throw Error("invalid_replay_control");
    if (v.action === "seek") {
      if (!Number.isInteger(v.fromSec)) throw Error("invalid_replay_control");
      return this.initialize(v.fromSec as number, this.speed, true);
    }
    if (!this.engine || this.busy) throw Error("replay_loading");
    if (v.action === "pause") { this.engine.pause(); if (this.state !== "ended") this.state = "paused"; }
    else if (v.action === "resume") { if (this.state !== "ended") { this.state = "playing"; this.engine.resume(); } }
    else if (v.action === "speed" && speeds.includes(v.speed as number)) { this.speed = v.speed as number; this.engine.changeSpeed(this.speed); }
    else if (v.action === "step" && [1, 10, 60].includes(v.seconds as number) && this.state === "paused") {
      this.busy = true;
      try { await this.engine.step(v.seconds as number); } finally { if (this.current(g)) this.busy = false; }
    } else throw Error("invalid_replay_control");
    if (this.current(g)) { this.vp(true); this.notify(true); }
  }
  stop() { this.stopped = true; this.engine?.stop(); }
}
