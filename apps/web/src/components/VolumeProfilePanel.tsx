import type { AnalysisVolumeProfileView } from "@workspace/core/analysis-hub";
import { tickToY, type Viewport } from "@workspace/core/viewport";
import { ticksToPrice } from "@workspace/core";

const SCALE = 10000n;
/** Bigint-safe ratio in [0,1]; quantities are never converted with Number(). */
export function bigRatio(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const r = part >= whole ? SCALE : part * SCALE / whole;
  return Number(r) / Number(SCALE);
}

interface Props {
  profile: AnalysisVolumeProfileView | null;
  vp: Viewport;
  revision: number | null;
  width?: number;
}

/** Session-cumulative observed Volume Profile. Rows use the shared tickToY (tick center). */
export function VolumeProfilePanel({ profile, vp, revision, width = 240 }: Props) {
  const h = vp.bounds.height;
  const levels = profile?.levels ?? [];
  const max = levels.reduce((m, l) => (l.totalVolume > m ? l.totalVolume : m), 0n);
  const plot = Math.max(0, width - 8);
  const pitch = (() => {
    const a = vp.price ? tickToY(vp, 0) : null, b = vp.price ? tickToY(vp, 1) : null;
    return a === null || b === null ? 0 : Math.abs(a - b);
  })();
  const barH = Math.max(1, pitch * 0.8);
  const val = profile?.valueArea.valTick ?? null, vah = profile?.valueArea.vahTick ?? null;
  const y = (t: number) => (vp.price ? tickToY(vp, t) : null);
  const line = (id: string, label: string, tick: number | null, cls: string) => {
    const yy = tick === null ? null : y(tick);
    if (tick === null || yy === null) return null;
    return (
      <g key={id} data-testid={id} data-tick={tick} data-y={yy.toFixed(3)}>
        <line x1={0} x2={width} y1={yy} y2={yy} className={cls} />
        <text x={4} y={yy - 3} className="vp-text">{label} {ticksToPrice(tick).toFixed(2)} ({tick} ticks)</text>
      </g>
    );
  };
  return (
    <>
      <div className="vp-col" data-testid="vp-panel" data-revision={revision ?? ""}
        data-status={profile ? (levels.length ? "OBSERVED" : "EMPTY") : "NO DATA"}>
        <svg width={width} height={h} data-testid="vp-svg">
          {levels.map((l) => {
            const yy = y(l.priceTicks);
            if (yy === null) return null;
            const inVa = val !== null && vah !== null && l.priceTicks >= val && l.priceTicks <= vah;
            const total = bigRatio(l.totalVolume, max) * plot;
            const b = bigRatio(l.buyVolume, max) * plot;
            // Cumulative edges keep rounding residue out of UNKNOWN when U=0.
            const knownEdge = bigRatio(l.buyVolume + l.sellVolume, max) * plot;
            const s = Math.max(0, knownEdge - b), u = Math.max(0, total - knownEdge);
            const top = yy - barH / 2;
            return (
              <g key={l.priceTicks} data-testid={`vp-level-${l.priceTicks}`} data-tick={l.priceTicks} data-y={yy.toFixed(3)}
                data-total={l.totalVolume.toString()} data-in-value-area={String(inVa)}>
                {inVa && <rect x={0} y={top - 1} width={width} height={barH + 2} className="vp-va" />}
                <rect x={0} y={top} width={b} height={barH} className="vp-b" />
                <rect x={b} y={top} width={s} height={barH} className="vp-s" />
                <rect x={b + s} y={top} width={u} height={barH} className="vp-u" />
              </g>
            );
          })}
          {line("vp-vah", "VAH", vah, "vp-line vp-line-va")}
          {line("vp-val", "VAL", val, "vp-line vp-line-va")}
          {line("vp-poc", "POC", profile?.pocTick ?? null, "vp-line vp-line-poc")}
          {!profile && <text x={width / 2} y={h / 2} textAnchor="middle" className="empty-text">NO DATA</text>}
        </svg>
        <span className="vp-label">VP / SESSION CUMULATIVE / MOCK</span>
      </div>
      <div className="vp-info" data-testid="vp-info" tabIndex={0} aria-label="Session Volume Profile details (scrollable)">
        <div data-testid="vp-scope-note">Session cumulative, accepted observed Trades only. Not a visible-range profile; market completeness is NOT asserted.</div>
        {!profile ? (
          <div data-testid="vp-empty">NO DATA: profile unavailable (not zero volume).</div>
        ) : (
          <>
            <div data-testid="vp-totals">
              B {profile.totals.buyVolume.toString()} / S {profile.totals.sellVolume.toString()} / U {profile.totals.unknownVolume.toString()} / V {profile.totals.totalVolume.toString()} / trades {profile.totals.tradeCount}
            </div>
            <div data-testid="vp-levels-summary">
              POC {profile.pocTick ?? "none"} / VAL {val ?? "none"} / VAH {vah ?? "none"} ticks / VA volume {profile.valueArea.includedVolume.toString()} (70%) / levels {profile.priceLevels}/{profile.maxPriceLevels}
            </div>
            {profile.totals.unknownVolume > 0n && (
              <div data-testid="vp-unknown-note">UNKNOWN aggressor volume {profile.totals.unknownVolume.toString()} is not split into BUY/SELL (grey segment).</div>
            )}
            {!profile.classificationComplete && <div data-testid="vp-classification">classification incomplete</div>}
            {profile.nonValidTradeQuality && <div data-testid="vp-quality-warn">Trade quality not VALID</div>}
            {profile.unknownTimePrecision && <div data-testid="vp-precision-warn">unknown time precision</div>}
            <div data-testid="vp-quality">Trade lane {profile.quality.channel.status} / status {profile.status}</div>
            {levels.length === 0 && <div data-testid="vp-no-levels">No accepted Trade observed yet (not market zero).</div>}
            {levels.map((l) => (
              <div key={l.priceTicks} data-testid={`vp-row-${l.priceTicks}`}>
                {l.priceTicks}: B {l.buyVolume.toString()} S {l.sellVolume.toString()} U {l.unknownVolume.toString()} = {l.totalVolume.toString()}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
