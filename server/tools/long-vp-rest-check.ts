/** REST-only smoke check. No WebSocket, database client, filesystem persistence, or receiver import. */
import { LongRest } from "../src/long-vp/rest.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { fill } from "../src/long-vp/fill.ts";

const key = process.env.TICKSTREAM_API_KEY;
if (!key) throw Error("TICKSTREAM_API_KEY_missing");
const signal = AbortSignal.timeout(120000);
try {
  const source = new LongRest(key);
  const roll = await source.roll(signal);
  const endUs = Math.floor((Date.now() - 10 * 60000) / 60000) * 60000 * 1000;
  const startUs = endUs - 60000_000;
  const direct = await source.ticks(startUs, endUs, signal);
  if (direct.truncated) throw Error("smoke_window_truncated");
  const aggregate = new LongAggregate();
  const result = await fill(source, aggregate, [{ startUs, endUs }], [roll], signal);
  const expectedBuy = direct.trades.filter(t => t.side === "buy").reduce((s, t) => s + t.size, 0);
  const expectedSell = direct.trades.filter(t => t.side === "sell").reduce((s, t) => s + t.size, 0);
  const rows = [...aggregate.volumes.values()];
  const buy = rows.reduce((s, t) => s + t.buy, 0), sell = rows.reduce((s, t) => s + t.sell, 0);
  if (aggregate.count !== direct.trades.length || buy !== expectedBuy || sell !== expectedSell || result.gaps.length)
    throw Error("rest_aggregation_mismatch");
  console.log(JSON.stringify({ event: "long_vp_rest_check", source: "TICK_STREAM_REAL_REST",
    writes: 0, websocketConnections: 0, roll, startUs, endUs, ...aggregate.snapshot(), buy, sell,
    directTrades: direct.trades.length, directBuy: expectedBuy, directSell: expectedSell,
    matched: true, coverage: result.coverage, gaps: result.gaps }));
} catch {
  // A raw fetch/driver error must never reach a console with credential-bearing details.
  console.error(JSON.stringify({ event: "long_vp_rest_check_failed", reason: "request_or_comparison_failed" }));
  process.exitCode = 1;
}
