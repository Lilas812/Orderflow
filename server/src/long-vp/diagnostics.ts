import { randomUUID } from "node:crypto";
import type { Log } from "../logger.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";

type Fields = Record<string, string | number | boolean | null>;
interface Stage { id: number; name: string; started: number; fields: Fields; }

/** Bounded, payload-free observations. Never participates in storage or scheduling. */
export class LongVpDiagnostics {
  private active: { id: string; started: number; lastWait: number } | null = null;
  private stages: Stage[] = [];
  private sequence = 0;
  private symbol: MarketSymbol;
  private log: Log;
  private context: () => Fields;
  private now: () => number;
  constructor(symbol: MarketSymbol, log: Log, context: () => Fields, now = () => performance.now()) {
    this.symbol = symbol; this.log = log; this.context = context; this.now = now;
  }

  private write(event: string, fields: Fields) {
    // A diagnostic writer must not change success/failure of the original operation.
    try { this.log(event, { ...fields, symbol: this.symbol, runId: this.active?.id ?? null }); } catch {}
  }
  note(fields: Fields) { this.write("long_vp_decision", fields); }
  async run<T>(work: () => Promise<T>): Promise<T> {
    const started = this.now();
    this.active = { id: randomUUID(), started, lastWait: started };
    this.sequence = 0;
    this.write("long_vp_run_started", {});
    let outcome = "failed";
    try {
      const result = await work();
      outcome = "complete";
      return result;
    } finally {
      this.write("long_vp_run_finished", { outcome, elapsedMs: this.now() - started });
      this.active = null;
      this.stages = [];
    }
  }
  async stage<T>(name: string, fields: Fields, work: () => Promise<T>,
    summary?: (result: T) => Fields): Promise<T> {
    const stage = { id: ++this.sequence, name, started: this.now(), fields };
    this.stages.push(stage);
    this.write("long_vp_stage_started", { ...fields, stage: name, stageId: stage.id });
    let outcome = "failed", resultFields: Fields = {};
    try {
      const result = await work();
      outcome = "complete";
      if (summary) resultFields = summary(result);
      return result;
    } finally {
      this.write("long_vp_stage_finished", { ...fields, ...resultFields, stage: name, stageId: stage.id,
        outcome, elapsedMs: this.now() - stage.started });
      this.stages.pop();
    }
  }
  /** Called by the existing 60s service tick; no additional timer or request. */
  waiting() {
    const run = this.active, stage = this.stages.at(-1), now = this.now();
    if (!run || !stage || now - run.lastWait < 300000) return;
    run.lastWait = now;
    let context: Fields;
    try { context = this.context(); } catch { context = { contextState: "unavailable" }; }
    this.write("long_vp_stage_waiting", { ...context, ...stage.fields, stage: stage.name,
      stageId: stage.id, elapsedMs: now - stage.started, runElapsedMs: now - run.started });
  }
}
