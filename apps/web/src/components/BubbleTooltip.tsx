import type { BubbleState } from "@workspace/core/bubble-finality";
import { fmtJst } from "./TimeAxis";

export interface BubbleTip {
  x: number; y: number; state: BubbleState; diameter: number | null;
}

const utc = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace("T", " ").replace("Z", " UTC");
const W = 300, H = 300;

export function BubbleTooltip({ tip, width, height }: { tip: BubbleTip; width: number; height: number }) {
  const k = tip.state.bucket;
  const left = Math.max(0, Math.min(tip.x + 12 > width - W ? tip.x - W - 12 : tip.x + 12, width - W));
  const top = Math.max(0, Math.min(tip.y + 12 > height - H ? tip.y - H - 12 : tip.y + 12, height - H));
  const centerTick = (k.minTick + k.maxTick) / 2;
  const withheld = "withheld (INCOMPLETE)";
  const bias = k.delta === null ? withheld : k.delta > 0n ? "BUY" : k.delta < 0n ? "SELL" : "NEUTRAL";
  return (
    <div className="bb-tip" data-testid="bubble-tooltip" data-bubble-id={tip.state.id}
      data-status={tip.state.status} data-revision={tip.state.revision}
      style={{ left, top, width: W }}>
      <div>MOCK / SIMULATED / {tip.state.status} / rev {tip.state.revision}{tip.state.finalized ? " / finalized" : ""}</div>
      <div>start {fmtJst(k.startNs, true)} <span className="dim">{utc(k.startNs)}</span></div>
      <div>end {fmtJst(k.endNs, true)} <span className="dim">{utc(k.endNs)}</span></div>
      <div>ticks {k.minTick}..{k.maxTick} ({k.minTick / 4}..{k.maxTick / 4} pts)</div>
      <div>center tick {centerTick} / {centerTick / 4} pts</div>
      <div>B {k.B.toString()} / S {k.S.toString()} / U {k.U.toString()}</div>
      <div>V {k.V === null ? withheld : k.V.toString()} (observed raw {k.V_raw.toString()})</div>
      <div>Delta {k.delta === null ? withheld : k.delta.toString()} / bias {bias}</div>
      <div>|Delta| / V {k.imbalancePercent === null ? withheld : `${k.imbalancePercent.toFixed(6)}%`}</div>
      <div>bucket {k.status}{k.quality.length ? ` (${k.quality.join(",")})` : ""}</div>
      <div>source trades {k.tradeIds.length}</div>
      <div>diameter {tip.diameter === null ? "—" : `${tip.diameter.toFixed(6)} px`}</div>
    </div>
  );
}
