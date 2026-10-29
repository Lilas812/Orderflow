import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Receiver } from "./ingest/receiver.ts";
import { Pipeline } from "./pipeline.ts";
import { Hub } from "./hub/hub.ts";
import { AppStore } from "./store/app.ts";
import { LongObjects } from "./long-vp/objects.ts";
import { LongRest } from "./long-vp/rest.ts";
import { AppLongVp, accumulationEnabled, productionAccumulation } from "./long-vp/app-service.ts";
import { statusSnapshot } from "./status/app.ts";
import type { Objects } from "./store/objects.ts";
import type { Upstream } from "./upstream/connection.ts";
import type { Log } from "./logger.ts";

/** Instrument-local state; no listener and no upstream socket are created here. */
export function createGcRuntime(options: {
  key: string; log: Log; request: typeof fetch; objects: Objects | null; root: string | null;
  prefix: string; env: NodeJS.ProcessEnv; upstream(): Upstream;
}) {
  const log: Log = (event, fields) => options.log(event, {
    ...(fields && typeof fields === "object" ? fields : { detail: fields }), symbol: "GC" });
  let longVp: AppLongVp | null = null;
  const pipeline = new Pipeline(options.key, () => receiver.nextSequence(), log, c => hub.column(c),
    options.objects ? new AppStore(path.join(options.root!, "instruments/GC"), options.objects,
      options.prefix + "instruments/GC/", log, Date.now, "GC") : undefined, "GC", options.request);
  const receiver = new Receiver(log, {
    book: b => { pipeline.book(b); hub.book(b); },
    trade: t => { pipeline.trade(t); hub.trade(t); longVp?.trade(t); },
  }, "GC");
  if (accumulationEnabled(options.env) && options.objects && options.root) {
    longVp = new AppLongVp({
      repository: new LongObjects(options.objects, options.prefix, path.join(options.root, "longvp-gc-working"), "GC"),
      store: pipeline.store, history: pipeline.client, metrics: pipeline.historyMetrics,
      metadata: new LongRest(options.key, options.request, undefined, "GC", c => { receiver.currentContract = c; }),
      nextSeq: () => receiver.nextSequence(), log,
      ready: async signal => {
        if (!productionAccumulation(options.env)) return;
        while (pipeline.status().seamL === null) await delay(1000, undefined, { signal });
        await Promise.all([pipeline.backfill.settled(), pipeline.vpHistory.settled()]);
        signal.throwIfAborted();
      },
    });
  }
  const hub: Hub = new Hub({
    savedRange: () => pipeline.store.savedRange, read: (a, b) => pipeline.readRange(a, b),
    readTrades: (a, b, visit, signal) => pipeline.readFootprintRange(a, b, visit, signal),
    ownsLiveTrade: trade => pipeline.ownsFootprintLive(trade),
    vp: () => pipeline.vp, replayVp: (a, alive) => pipeline.replayVp(a, alive),
    status: () => statusSnapshot(options.upstream(), receiver, options.key, () => {
      const { vp: _vp, ...rest } = pipeline.status(); return rest;
    }, () => hub.snapshot()),
  }, log, undefined, "GC");
  return { receiver, pipeline, hub, longVp,
    extra: () => pipeline.status(), delivery: () => ({ ...hub.snapshot(), connections: hub.connections() }) };
}
