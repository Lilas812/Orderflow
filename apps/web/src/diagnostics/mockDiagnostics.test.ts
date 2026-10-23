import { afterEach, expect, it, vi } from "vitest";
import { UNIFIED_MOCK_STREAM } from "@workspace/fixtures";
import { createMockAnalysisSession } from "../lib/mockAnalysisSession";
import { unifiedChecks } from "../hooks/useMockAnalysisSession";
import {
  ROW_LIMIT, createRecorder, startDiagnostics, releaseDiagnostics, setDiagnosticReader,
  diagnostics, beginDraw, endDraw, diagnosticMode,
} from "./mockDiagnostics";

afterEach(() => { releaseDiagnostics(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("allocates exactly a fixed numeric slab and returns defensive copies", () => {
  const d = createRecorder(7);
  d.add("ingest", 3, 2);
  const s = d.snapshot();
  expect(s.allocatedBytes).toBe(ROW_LIMIT * 9 * 8);
  s.rows[0].revision = 999;
  expect(d.snapshot().rows[0].revision).toBe(3);
});
it("stops recording at the fixed limit without growing the slab", () => {
  const d = createRecorder(1);
  for (let i = 0; i < ROW_LIMIT + 25; i++) d.add("frame", i);
  expect(d.snapshot()).toMatchObject({ saturated: true, dropped: 25 });
  expect(d.snapshot().rows).toHaveLength(ROW_LIMIT);
});
it("rejects nonfinite metadata", () => {
  const d = createRecorder(1); d.add("frame", NaN);
  expect(d.snapshot().rows).toHaveLength(0);
  expect(d.snapshot().dropped).toBe(1);
});
it("dispose releases the slab and makes stale callbacks inert", () => {
  const d = createRecorder(1); d.add("frame", 1); d.dispose(); d.add("frame", 2);
  expect(d.snapshot()).toMatchObject({ allocatedBytes: 0, rows: [] });
});
it("default mode creates no collector or bridge", () => {
  vi.stubGlobal("window", { location: { search: "" } });
  expect(diagnosticMode()).toBe("off");
  expect(startDiagnostics(1)).toBeUndefined();
  expect(window.__orderflowMockDiagnostics).toBeUndefined();
});
it("control mode exposes derived meaning but allocates no telemetry slab", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=control" } });
  expect(startDiagnostics(1)).toBeUndefined();
  setDiagnosticReader(() => ({ quantity: 900719925474099312345n }));
  expect(window.__orderflowMockDiagnostics?.snapshot()).toBeNull();
  expect(window.__orderflowMockDiagnostics?.meaning()).toContain("900719925474099312345");
});
it("caps diagnostic semantic output", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=control" } });
  startDiagnostics(1); setDiagnosticReader(() => "x".repeat(65537));
  expect(() => window.__orderflowMockDiagnostics?.meaning()).toThrow("SEMANTIC_LIMIT");
});
it("records actual draw revision separately from received/DOM revision", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1" } });
  startDiagnostics(1);
  diagnostics()?.add("received", 4, -1, "heatmap");
  const token = beginDraw("heatmap", 3, 1);
  window.__orderflowMockDiagnostics?.gl("heatmap", 3, .01, 18, 0);
  endDraw(token, 18);
  expect(diagnostics()?.snapshot().rows.map(r => r.revision)).toEqual([4, 3, 3]);
  expect(window.__orderflowMockDiagnostics?.activeDraw()).toBeUndefined();
});
it("restart clears old records, slab, reader and active draw", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1" } });
  const first = startDiagnostics(1)!;
  first.add("frame", 1); setDiagnosticReader(() => "old"); beginDraw("bubble", 1);
  startDiagnostics(2);
  expect(first.snapshot().allocatedBytes).toBe(0);
  expect(diagnostics()?.snapshot()).toMatchObject({ sessionId: 2, rows: [] });
  expect(window.__orderflowMockDiagnostics?.meaning()).toBeNull();
  expect(window.__orderflowMockDiagnostics?.activeDraw()).toBeUndefined();
});
it("release removes the public diagnostic bridge and all retained references", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1" } });
  const d = startDiagnostics(1)!; setDiagnosticReader(() => "derived");
  releaseDiagnostics();
  expect(d.snapshot().allocatedBytes).toBe(0);
  expect(diagnostics()).toBeUndefined();
  expect(window.__orderflowMockDiagnostics).toBeUndefined();
});
it("baseline13 ON/OFF has exactly equal frames, counts, quality, bubbles and golden", () => {
  vi.useFakeTimers();
  const run = (enabled: boolean) => {
    const d = enabled ? createRecorder(1) : undefined;
    const s = createMockAnalysisSession({ ...UNIFIED_MOCK_STREAM, inputEveryMs: 300, diagnostics: d });
    s.setNotificationsEnabled(false); s.start(); vi.advanceTimersByTime(4000);
    const frame = s.readFrame(), status = s.getStatus(), rows = d?.snapshot().rows;
    expect(unifiedChecks(frame).every(c => c.ok)).toBe(true);
    expect(status.processedInputs).toBe(13);
    if (enabled) {
      expect(rows?.filter(r => r.stage === "ingest").map(r => r.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
      expect(rows?.some(r => r.stage === "frame")).toBe(true);
    }
    s.dispose(); expect(d?.snapshot().allocatedBytes ?? 0).toBe(0);
    return { frame, status };
  };
  expect(run(true)).toEqual(run(false));
});
it("session stop releases recording and leaves no timer after dispose", () => {
  vi.useFakeTimers(); const d = createRecorder(1);
  const s = createMockAnalysisSession({ ...UNIFIED_MOCK_STREAM, inputEveryMs: 300, diagnostics: d });
  s.setNotificationsEnabled(false); s.start(); vi.advanceTimersByTime(300);
  s.stop(); expect(d.snapshot().allocatedBytes).toBe(0);
  s.dispose(); expect(vi.getTimerCount()).toBe(0);
});
