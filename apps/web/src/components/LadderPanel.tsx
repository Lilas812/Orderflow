import type { LadderView } from "@workspace/core/ladder-view";
import { ticksToPrice } from "@workspace/core";
import { useTimeFormat } from "./SettingsContext";
import { LadderRow } from "./LadderRow";

interface Props {
  view: LadderView | null;
  error: string | null;
  /** Verification observation clock of the selected MOCK step (not the book time). */
  observedNs: string | null;
  stepLabel: string;
  timeMode: "LIVE" | "HISTORY";
}

const tickLabel = (view: LadderView, tick: number | null) => {
  if (tick === null) return "\u2014";
  const r = view.rows.find((x) => x.priceTicks === tick);
  return r ? r.priceLabel : ticksToPrice(tick).toFixed(2);
};
const txt = (o: unknown) => (o === null || o === undefined ? "\u2014" : Object.entries(o as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join(" / "));

/** Plot column (same grid row as the chart; no header above) + status panel in the Delta/time-axis rows. */
export function LadderPanel({ view, error, observedNs, stepLabel, timeMode }: Props) {
  const { fmt } = useTimeFormat();
  const jst = (ns: string | null) => (ns ? fmt(ns, true) : "\u2014");
  return (
    <>
      <div className="lad-col" data-testid="ladder-panel">
        <div className="lad-plot" data-testid="ladder-plot" data-quality={view?.quality ?? ""}>
          <div className="lad-head"><span>Ask Qty</span><span>Price</span><span>Bid Qty</span></div>
          {view?.rows.map((r) => <LadderRow key={r.priceTicks} row={r} />)}
          {!view && <div className="lad-empty">NO DATA</div>}
        </div>
      </div>
      <div className="lad-info">
        <div data-testid="ladder-reference" data-time-mode={timeMode}>LATEST MOCK SNAPSHOT / {timeMode}
          <div>{timeMode === "HISTORY" ? "チャート過去 / ラダー最新MOCK（別時点）" : "LIVE viewportのみ・実市場には未接続"}</div></div>
        <div data-testid="ladder-status" data-quality={view?.quality ?? "NONE"}>
          <b>{view?.quality ?? "NO DATA"}</b> / <span title={stepLabel}>{stepLabel.split(":")[0]}</span>
          {view?.crossed && <span className="dbg-warn"> CROSSED</span>}
          {view?.locked && <span className="dbg-warn"> LOCKED</span>}
          {error && <span className="dbg-warn" role="alert"> {error}</span>}
        </div>
        <div data-testid="ladder-best" data-guaranteed={String(view?.topOfBookGuaranteed ?? false)}>
          {view ? (view.topOfBookGuaranteed
            ? <>Best B {tickLabel(view, view.bestBidTick)} / A {tickLabel(view, view.bestAskTick)}</>
            : <>範囲内候補、市場全体Best未保証: B {tickLabel(view, view.observedBidTick)} / A {tickLabel(view, view.observedAskTick)}</>) : "\u2014"}
        </div>
        <div data-testid="ladder-time" data-book-ns={view?.asOfNs ?? ""} data-observed-ns={observedNs ?? ""}>
          <div>板 {jst(view?.asOfNs ?? null)} ({view?.asOfKind === "EXCHANGE_TIME_NS" ? "exchange" : view?.asOfKind === "RECEIVE_TIME_NS" ? "receive" : "NONE"})</div>
          <div>検証時計 {jst(observedNs)}</div>
        </div>
        <div className="dim" title={txt(view?.identity)}>{view?.identity ? txt(view.identity) : "identity \u2014"}</div>
        <div className="dim" title={txt(view?.depthScope)}>depth {view?.depthScope ? txt(view.depthScope) : "\u2014"}</div>
        <div className="dim">0 = 既知0枚 / — = 不明 / — OUT = 範囲外</div>
        {view?.warnings.map((w) => <div key={w} className="dbg-warn">{w}</div>)}
        <button type="button" className="btn" disabled data-testid="button-ladder-profile">Profile未実装</button>
      </div>
    </>
  );
}
