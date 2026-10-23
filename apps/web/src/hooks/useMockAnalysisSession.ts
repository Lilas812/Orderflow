import { useCallback, useEffect, useRef, useState } from "react";
import { UNIFIED_MOCK_STREAM } from "@workspace/fixtures";
import type { AnalysisRenderFrame } from "@workspace/core/analysis-hub";
import { createMockAnalysisSession } from "../lib/mockAnalysisSession";
import { startDiagnostics, releaseDiagnostics, setDiagnosticReader, diagnosticMode } from "../diagnostics/mockDiagnostics";

/** Explicit finite-demo speeds. 300 ms/input lets a 250 ms notification observe the transient L2 GAP. */
export const UNIFIED_SPEEDS = [50, 300, 800] as const;
export const UNIFIED_DEFAULT_SPEED = 300;
export const UNIFIED_NOTICE_MS = 250; // <= 4 Hz

export type UnifiedPhase = "OFF" | "RUNNING" | "COMPLETED" | "STOPPED";
export interface UnifiedStatus {
  readonly state: string; readonly reason: string;
  readonly processedInputs: number; readonly sourceInputs: number;
  readonly processedMarketEvents: number; readonly acceptedMarketEvents: number;
  readonly revision: number; readonly timers: number;
}
export interface UnifiedSnapshot {
  readonly phase: UnifiedPhase;
  readonly frame: AnalysisRenderFrame | null;
  readonly status: UnifiedStatus | null;
  /** Frames published to React (one per revision change, <= 4 Hz). */
  readonly notices: number;
  /** Increments on every explicit start; viewport seed resets only on this. */
  readonly runId: number;
  readonly inputEveryMs: number;
}
const OFF: UnifiedSnapshot = { phase: "OFF", frame: null, status: null, notices: 0, runId: 0, inputEveryMs: UNIFIED_DEFAULT_SPEED };

export interface UnifiedCheck { readonly name: string; readonly ok: boolean; readonly detail: string }

/** Compares a frame to the fixture's declared expectations (read-only; no replay). */
export function unifiedChecks(frame: AnalysisRenderFrame): UnifiedCheck[] {
  const e = UNIFIED_MOCK_STREAM.expected;
  const vp = frame.volumeProfile.value;
  const out: UnifiedCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  add("VP B/S/U/V", !!vp && vp.totals.buyVolume === e.B && vp.totals.sellVolume === e.S &&
    vp.totals.unknownVolume === e.U && vp.totals.totalVolume === e.volume,
  vp ? `${vp.totals.buyVolume}/${vp.totals.sellVolume}/${vp.totals.unknownVolume}/${vp.totals.totalVolume}` : "NO DATA");
  add("VP POC/VAL/VAH", !!vp && vp.pocTick === e.pocTick && vp.valueArea.valTick === e.valTick &&
    vp.valueArea.vahTick === e.vahTick && vp.valueArea.includedVolume === e.valueAreaVolume,
  vp ? `${vp.pocTick}/${vp.valueArea.valTick}/${vp.valueArea.vahTick}/${vp.valueArea.includedVolume}` : "NO DATA");
  const d = frame.delta.items.map(b => b.delta === null ? "null" : b.delta.toString());
  const ed = e.delta.map(v => v === null ? "null" : v.toString());
  add("Delta bins", d.length === ed.length && d.every((v, i) => v === ed[i]), d.join(","));
  const twa = frame.heatmap.cells.map(c => c.twa);
  add("BID TWA", twa.length === e.bidTwa.length && twa.every((v, i) => v === e.bidTwa[i]),
    twa.map(v => v === null ? "NO DATA" : String(v)).join(","));
  const revs = [frame.book.revision, frame.heatmap.revision, frame.bubbles.revision, frame.delta.revision,
    frame.volumeProfile.revision, frame.quality.revision];
  add("Common revision", revs.every(r => r === frame.revision), `${frame.revision}`);
  return out;
}

/**
 * Explicit lifecycle only: nothing runs until start(). One finite session per start, one
 * input timer (inside the session) and one <=4 Hz publication timer here. The session's own
 * notification pump is disabled, so there is exactly one pump. React state changes at most
 * once per publication, never per input/Trade. Frames come only from readFrame(query).
 */
export function useMockAnalysisSession() {
  const [snap, setSnap] = useState<UnifiedSnapshot>(OFF);
  const live = useRef<{ session: ReturnType<typeof createMockAnalysisSession>; timer: number } | null>(null);
  const counters = useRef({ notices: 0, runId: 0, lastRevision: -1 });

  const teardown = useCallback(() => {
    const l = live.current; live.current = null;
    releaseDiagnostics();
    if (!l) return;
    window.clearInterval(l.timer);
    l.session.dispose();
  }, []);

  const start = useCallback((inputEveryMs: number = UNIFIED_DEFAULT_SPEED) => {
    teardown();
    const c = counters.current; c.runId++; c.notices = 0; c.lastRevision = -1;
    const diagnostic = startDiagnostics(c.runId);
    const inspection = diagnosticMode() !== "off";
    const session = createMockAnalysisSession({
      scope: UNIFIED_MOCK_STREAM.scope, inputs: UNIFIED_MOCK_STREAM.inputs,
      query: UNIFIED_MOCK_STREAM.query, inputEveryMs, diagnostics: diagnostic,
    });
    session.setNotificationsEnabled(false);
    const runId = c.runId;
    let tick = 0;
    let timerStart = 0;
    const publish = () => {
      const entered = diagnostic ? performance.now() : 0;
      tick++;
      const status = session.getStatus();
      const terminal = status.state !== "RUNNING" && status.state !== "DRAINING";
      const changed = status.revision !== c.lastRevision;
      if (!changed) diagnostic?.add("publish", status.revision, status.processedInputs, "root",
        performance.now() - entered, timerStart + tick * UNIFIED_NOTICE_MS, entered, 0);
      if (changed) {
        try {
          const frame = session.readFrame(UNIFIED_MOCK_STREAM.query);
          c.lastRevision = status.revision; c.notices++;
          const phase: UnifiedPhase = terminal ? (status.state === "COMPLETED" ? "COMPLETED" : "STOPPED") : "RUNNING";
          if (inspection) {
            const publishedAt = performance.now();
            setDiagnosticReader(() => ({ frame, checks: unifiedChecks(frame), counts: status.counts,
              revision: status.revision, processedInputs: status.processedInputs, state: status.state }));
            diagnostic?.add("publish", frame.revision, status.processedInputs, "root", publishedAt - entered,
              timerStart + tick * UNIFIED_NOTICE_MS, entered, publishedAt);
          }
          setSnap({ phase, frame, status, notices: c.notices, runId, inputEveryMs });
        } catch {
          session.stop();
          releaseDiagnostics();
          setSnap(s => ({ ...s, phase: "STOPPED",
            status: { ...session.getStatus(), reason: "RENDER_FRAME_FAILED" } }));
          finish();
          return;
        }
      } else if (terminal) {
        setSnap(s => ({ ...s, phase: status.state === "COMPLETED" ? "COMPLETED" : "STOPPED", status }));
      }
      if (terminal) {
        finish();
        if (status.state !== "COMPLETED") releaseDiagnostics();
      }
    };
    const finish = () => {
      const l = live.current;
      if (l && l.session === session) window.clearInterval(l.timer);
    };
    session.start();
    if (diagnostic) timerStart = performance.now();
    const timer = window.setInterval(publish, UNIFIED_NOTICE_MS);
    live.current = { session, timer };
    setSnap({ phase: "RUNNING", frame: null, status: session.getStatus(), notices: 0, runId, inputEveryMs });
  }, [teardown]);

  const stop = useCallback(() => {
    const l = live.current; if (!l) return;
    l.session.stop();
    window.clearInterval(l.timer);
    const status = l.session.getStatus();
    let frame: AnalysisRenderFrame | null = null;
    try { frame = status.revision > 0 ? l.session.readFrame(UNIFIED_MOCK_STREAM.query) : null; } catch { frame = null; }
    const c = counters.current;
    if (frame) { c.notices++; c.lastRevision = status.revision; }
    setSnap(s => ({ ...s, phase: "STOPPED", status, frame: frame ?? s.frame, notices: c.notices }));
    releaseDiagnostics();
  }, []);

  const exit = useCallback(() => { teardown(); setSnap(OFF); }, [teardown]);
  const restart = useCallback((inputEveryMs?: number) => start(inputEveryMs ?? snap.inputEveryMs), [start, snap.inputEveryMs]);

  useEffect(() => teardown, [teardown]);
  return { snap, start, stop, restart, exit };
}
