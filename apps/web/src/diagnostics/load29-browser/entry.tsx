import React, { Profiler, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChartShell } from "../../components/ChartShell";
import { createMockAnalysisSession } from "../../lib/mockAnalysisSession";
import { createRecorder } from "../mockDiagnostics";
import { DEFAULT_DISPLAY_SETTINGS } from "@workspace/core/settings-schema";
import type { UnifiedSnapshot } from "../../hooks/useMockAnalysisSession";
import type { AnalysisRenderFrame } from "@workspace/core/analysis-hub";
import { atomic, BUDGET, canonical, LAYOUT, marketCount, validate, viewportSeed, type Definition } from "./contracts";
import "../../styles.css";

declare global {
  interface Window {
    __load29Input: { stage: number; definition: Definition; host?: "electron" };
    __load29Send: (data: string) => void;
    __load29: { start(): void; prepareLayout?(): void; dispose(): unknown; snapshot(): unknown };
    __load29Observer: { snapshot(): unknown; geometry(): unknown; dispose(): unknown };
  }
}
const { stage, definition: d } = window.__load29Input;
validate(d, stage);
let sends = 0, fault: string | null = null, timer: ReturnType<typeof setInterval> | null = null;
let started = false, done = false, disposed = false, lastRevision = 0, lastAt = -Infinity;
let snap: UnifiedSnapshot = { phase: "OFF", frame: null, status: null, notices: 0, runId: 0, inputEveryMs: BUDGET.inputMs };
const frameRows: { revision: number; prefix: number; readMs: number; cache: string; hit: number; at: number; due: number }[] = [];
const reactRows: { revision: number; ms: number; at: number }[] = [];
const recorder = createRecorder(29 + stage, 2);
const session = createMockAnalysisSession({ ...d, inputEveryMs: BUDGET.inputMs, diagnostics: recorder });
session.setNotificationsEnabled(false); // Same public API and pump pattern used by the existing production hook.
let previousRead: AnalysisRenderFrame | null = null;
const readRows: { prefix: number; cache: string; ms: number; source: string }[] = [];
function read(prefix: number, source: string) {
  const begin = performance.now(), frame = session.readFrame(d.query), end = performance.now();
  const cache = frame === previousRead ? "HIT" : "MISS"; previousRead = frame;
  readRows.push({ prefix, cache, ms: end - begin, source });
  if (readRows.length > BUDGET.observerRows) throw Error("READ_LIMIT");
  return { frame, ms: end - begin, cache };
}
const originalAdd = recorder.add;
recorder.add = (...args) => {
  originalAdd(...args);
  const [kind, , prefix] = args;
  if (kind !== "ingest" || !prefix) return;
  const input = d.inputs[prefix - 1];
  const boundary = input.type === "CONDITION" || (stage === 2 && prefix > 1 &&
    input.type === "EVENT" && input.event.kind === "L2_SNAPSHOT");
  if (boundary) queueMicrotask(() => {
    try {
      if (session.getStatus().processedInputs !== prefix) throw Error("PROBE_PREFIX_MISMATCH");
      const { frame, ms, cache } = read(prefix, "quality-boundary-probe");
      atomic(frame);
      send({ kind: "probe", stage, prefix, revision: frame.revision, canonical: canonical(frame), ms, cache });
    } catch (error) { failure(error); }
  });
};
let update: (snapshot: UnifiedSnapshot) => void = () => {};
function send(event: unknown) {
  if (++sends > BUDGET.observerRows) throw Error("MESSAGE_LIMIT");
  window.__load29Send(JSON.stringify(event));
}
function failure(error: unknown) {
  fault = String(error);
  session.stop();
  if (timer !== null) clearInterval(timer);
  timer = null; done = true;
  send({ kind: "failure", stage, fault });
}
function start() {
  if (started) throw Error("RETRY_FORBIDDEN");
  started = true;
  session.start();
  snap = { ...snap, phase: "RUNNING", status: session.getStatus(), runId: 1 };
  update(snap);
  const base = performance.now(); let ticks = 0;
  timer = setInterval(() => {
    const at = performance.now(), due = base + (++ticks) * BUDGET.publishMs;
    try {
      const status = session.getStatus();
      if (status.state === "STOPPED") throw Error(status.reason);
      if (status.revision !== lastRevision && at - lastAt >= BUDGET.publishMs) {
        const firstRead = read(status.processedInputs, "publication");
        const secondRead = read(status.processedInputs, "immediate-hit");
        const frame = firstRead.frame, same = secondRead.frame;
        if (same !== frame) throw Error("CACHE_HIT_IDENTITY");
        if (frame.revision !== status.revision) throw Error("NOTICE_FRAME_REVISION");
        atomic(frame);
        lastRevision = frame.revision; lastAt = at;
        frameRows.push({ revision: frame.revision, prefix: status.processedInputs, readMs: firstRead.ms, cache: firstRead.cache,
          hit: secondRead.ms, at, due });
        if (frameRows.length > BUDGET.observerRows) throw Error("FRAME_LIMIT");
        send({ kind: "frame", stage, prefix: status.processedInputs, revision: frame.revision,
          canonical: canonical(frame), at, readMs: firstRead.ms, cache: firstRead.cache, hit: secondRead.ms });
        snap = { phase: status.state === "COMPLETED" ? "COMPLETED" : "RUNNING", frame, status,
          notices: snap.notices + 1, runId: 1, inputEveryMs: BUDGET.inputMs };
        update(snap);
      }
      if (status.state === "COMPLETED") {
        clearInterval(timer!); timer = null; done = true;
        send({ kind: "complete", stage, status });
      }
    } catch (error) { failure(error); }
  }, BUDGET.publishMs);
}
const root = createRoot(document.getElementById("root")!);
function App() {
  const [state, set] = useState(snap), [display, setDisplay] = useState(DEFAULT_DISPLAY_SETTINGS);
  const actions = useRef<React.ComponentProps<typeof ChartShell>["heatmapActionsRef"]["current"]>(null);
  update = set;
  return <Profiler id="load29-root" onRender={(_, __, ms) => {
    reactRows.push({ revision: state.frame?.revision ?? 0, ms, at: performance.now() });
    if (reactRows.length > BUDGET.observerRows) failure("REACT_ROW_LIMIT");
  }}>
    <div className="app" style={{ height: "100vh", width: window.__load29Input.host === "electron" ? "100%" : LAYOUT.parentWidth, maxWidth: "100%",
      padding: `16px ${LAYOUT.padding}px`, display: "flex", flexDirection: "column" }} data-testid="load29-page">
      <div>MOCK / SIMULATED — Task29 Stage {stage} — {d.inputs.length} inputs — NOT LIVE</div>
      <ChartShell trades={[]} mockOn={false} onToggleMock={() => {}} onAddThird={() => {}}
        heatmap={null} onSelectHeatmap={() => {}} bubbleId={null} onSelectBubble={() => {}} onBubbleRaw={() => {}}
        deltaId={null} onSelectDelta={() => {}} onDeltaRaw={() => {}} ladderId={null}
        onSelectLadder={() => {}} onLadderRaw={() => {}} display={display} onDisplay={setDisplay}
        heatmapActionsRef={actions} onOpenSettings={() => {}}
        unified={{ snap: state, speeds: [300], onStart: start, onRestart: () => { throw Error("RETRY_FORBIDDEN"); },
          onStop: () => failure("MANUAL_STOP"), onExit: () => window.__load29.dispose(),
          diagnosticChecks: [], // No baseline13/cells128 golden is falsely presented as this workload's golden.
          diagnosticDisplay: { id: "cells128", // layout identifier only; all three saved queries have 128 cells.
            sourceId: d.scope.config.identity.sourceId, sessionId: d.scope.config.identity.sessionId,
            inputs: d.inputs.length, markets: marketCount(d.inputs),
            trades: d.inputs.filter(i => i.type === "EVENT" && i.event.kind === "TRADE").length,
            seed: viewportSeed(d) } }} />
    </div>
  </Profiler>;
}
root.render(<App />);
window.__load29 = {
  start,
  ...(window.__load29Input.host === "electron" ? { prepareLayout() {
    if (started || snap.phase !== "OFF") throw Error("LAYOUT_PREPARE_ONCE");
    // A real empty hub frame mounts the real four panels before timed input.
    // No events, clock changes, fake market state or publication timer.
    const frame = session.readFrame(d.query);
    atomic(frame);
    snap = { ...snap, phase: "RUNNING", frame, status: session.getStatus(), runId: 1 };
    send({ kind: "frame", stage, prefix: 0, revision: frame.revision, canonical: canonical(frame),
      purpose: "pre-input-layout-only" });
    update(snap);
  } } : {}),
  snapshot: () => ({ stage, started, done, disposed, fault, status: session.getStatus(),
    timers: Number(timer !== null) + session.getStatus().timers, recorder: recorder.snapshot(),
    frameRows: [...frameRows], readRows: [...readRows], reactRows: [...reactRows], revision: lastRevision,
    viewport: document.querySelector('[data-testid="unified-controls"]')?.getAttribute("data-diagnostic-viewport"),
    panels: ["heatmap-canvas", "bubble-canvas", "delta-panel", "vp-panel"].map(testid => {
      const e = document.querySelector(`[data-testid="${testid}"]`);
      return { testid, exists: !!e, revision: e?.getAttribute("data-revision"),
        status: e?.getAttribute("data-status"), rect: e ? { width: e.getBoundingClientRect().width,
          height: e.getBoundingClientRect().height } : null,
        svgRects: testid === "vp-panel" ? e?.querySelectorAll("svg rect").length : undefined };
    }) }),
  dispose: () => {
    const before = session.getStatus();
    if (timer !== null) clearInterval(timer);
    timer = null; root.unmount(); session.dispose(); disposed = true;
    return { before, after: session.getStatus(), timers: 0, mountedCanvases: document.querySelectorAll("canvas").length };
  },
};
