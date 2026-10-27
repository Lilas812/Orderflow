import { test } from "node:test";
import assert from "node:assert/strict";
import { CpuMonitor } from "../src/diagnostics/cpu.ts";

test("CPU診断：タイマー前とサンプル間の使用時間も10秒・60秒平均へ含め、単位はコア", () => {
  const cpu = new CpuMonitor();
  assert.equal(cpu.snapshot().unit, "cores");
  assert.ok(cpu.snapshot().sampledSeconds > 0);
  cpu.sample();
  const start = process.hrtime.bigint();
  while (process.hrtime.bigint() - start < 20_000_000n) { /* process CPU, no dummy feed */ }
  const s = cpu.snapshot();
  assert.ok(s.average10s! > 0 && Number.isFinite(s.average10s));
  assert.ok(s.average60s! > 0 && Number.isFinite(s.average60s));
  assert.ok(s.sampledSeconds >= .02);
});
