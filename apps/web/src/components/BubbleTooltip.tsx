import { useState } from "react";
import type { BubbleState } from "@workspace/core/bubble-finality";
import type { VisualBubbleCluster } from "@workspace/render/bubble-clustering";
import { useTimeFormat } from "./SettingsContext";

export interface BubbleTip {
  x: number; y: number; state: BubbleState; diameter: number | null;
  cluster?: VisualBubbleCluster; pinned?: boolean;
}

const utc = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace("T", " ").replace("Z", " UTC");
const W = 320, H = 300;

export function BubbleTooltip({ tip, width, height, onClose }: { tip: BubbleTip; width: number; height: number; onClose?: () => void }) {
  const { fmt: fmtJst } = useTimeFormat();
  const [open, setOpen] = useState(false);
  const c = tip.cluster;
  const left = Math.max(0, Math.min(tip.x + 12 > width - W ? tip.x - W - 12 : tip.x + 12, width - W));
  const top = Math.max(0, Math.min(tip.y + 12 > height - H ? tip.y - H - 12 : tip.y + 12, height - H));
  const withheld = "withheld (INCOMPLETE)";
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const shell = {
    className: `bb-tip${tip.pinned ? " bb-tip-pinned" : ""}`, "data-testid": "bubble-tooltip",
    "data-pinned": String(!!tip.pinned), style: { left, top, width: W },
    onPointerDown: stop, onPointerUp: stop, onClick: stop, onWheel: stop,
  };
  const controls = (c || tip.pinned) && (
    <div className="bb-tip-ctl">
      {c && <button type="button" className="btn" data-testid="button-bubble-details" aria-expanded={open}
        disabled={!tip.pinned} onClick={() => setOpen((o) => !o)}>
        {open ? "Collapse source bubbles" : `Expand source bubbles (${c.children.length})`}
      </button>}
      {tip.pinned && onClose && <button type="button" className="btn" data-testid="button-bubble-close" onClick={onClose}>Close</button>}
      {!tip.pinned && <span className="dim">click bubble to pin and expand</span>}
    </div>
  );
  const details = c && open && tip.pinned && (
    <div className="bb-children" data-testid="bubble-child-details">
      {c.children.map((ch) => {
        const k = ch.source.bucket;
        return (
          <div key={ch.source.id} className="bb-child" data-child-id={ch.source.id}>
            <div>{ch.source.id}</div>
            <div>{fmtJst(k.startNs, true)} <span className="dim">{utc(k.startNs)} .. {utc(k.endNs)}</span></div>
            <div>ticks {k.minTick}..{k.maxTick} / B {k.B.toString()} S {k.S.toString()} V {k.V === null ? "withheld" : k.V.toString()}</div>
            <div>Delta {k.delta === null ? "withheld" : k.delta.toString()} / {ch.source.status} / rev {ch.source.revision}</div>
          </div>
        );
      })}
    </div>
  );

  if (c && c.children.length > 1) {
    const bias = c.delta > 0n ? "BUY" : c.delta < 0n ? "SELL" : "NEUTRAL";
    return (
      <div {...shell} data-bubble-id={c.id} data-status={c.status} data-revision={c.revision} data-source-count={c.children.length}>
        <div>MOCK / SIMULATED / CLUSTER of {c.children.length} source bubbles / {c.status} / rev {c.revision}</div>
        <div>start {fmtJst(c.startNs, true)} <span className="dim">{utc(c.startNs)}</span></div>
        <div>end {fmtJst(c.endNs, true)} <span className="dim">{utc(c.endNs)}</span></div>
        <div>ticks {c.minTick}..{c.maxTick} ({c.minTick / 4}..{c.maxTick / 4} pts)</div>
        <div>B {c.B.toString()} / S {c.S.toString()} / V {c.V.toString()}</div>
        <div>Delta {c.delta.toString()} / bias {bias}</div>
        <div>|Delta| / V {c.imbalancePercent.toFixed(6)}%</div>
        <div>diameter {c.diameter.toFixed(6)} px</div>
        {controls}{details}
        <div>ids {c.childrenIds.join(", ")}</div>
      </div>
    );
  }
  const k = tip.state.bucket;
  const centerTick = (k.minTick + k.maxTick) / 2;
  const bias = k.delta === null ? withheld : k.delta > 0n ? "BUY" : k.delta < 0n ? "SELL" : "NEUTRAL";
  return (
    <div {...shell} data-bubble-id={tip.state.id} data-status={tip.state.status} data-revision={tip.state.revision}
      data-source-count={1}>
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
      {controls}{details}
      {c && <div>ids {c.childrenIds.join(", ")}</div>}
    </div>
  );
}
