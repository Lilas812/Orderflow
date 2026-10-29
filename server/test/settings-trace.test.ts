import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { SettingsTrace } from "../src/settings/trace.ts";
import { settingsRouter } from "../src/settings/routes.ts";
import { AppSettings } from "../src/settings/app.ts";
import { LocalSettings } from "../src/settings/local.ts";
import { defaults } from "../src/settings/schema.ts";
import type { Objects } from "../src/store/objects.ts";
import type { SettingsPersistence } from "../src/settings/local.ts";

const history = () => ({ backfill: "running", vpHistory: "waiting",
  requests: 123, errors: 2, retries: 1, waiting: true });
type Event = { event: string; details: any };
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (condition()) return; await delay(10); }
  throw Error("trace_test_wait_timeout");
};
class DummyObjects implements Objects {
  bytes = Buffer.from(JSON.stringify({ version: 4, values: defaults, updatedAt: 1 }));
  hold: Promise<void> | null = null;
  verifying = false;
  fail: "upload" | "verification" | null = null;
  async exists() { return true; }
  async list() { return []; }
  async upload(_name: string, file: string) {
    if (this.fail === "upload") throw Error("NEVER_LOG_THIS_API_KEY_OR_SETTING");
    this.bytes = await fs.readFile(file);
  }
  async download(_name: string, file: string) {
    if (!file.endsWith(".cloud")) {
      this.verifying = true;
      if (this.hold) await this.hold;
      if (this.fail === "verification") {
        await fs.writeFile(file, "NEVER_LOG_THIS_API_KEY_OR_SETTING"); return;
      }
    }
    await fs.writeFile(file, this.bytes);
  }
}
async function fixture(cloud = true, enabled = true, throwingLog = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-trace-"));
  const events: Event[] = [];
  const trace = new SettingsTrace((event, details) => {
    if (throwingLog) throw Error("log_unavailable");
    events.push({ event, details: structuredClone(details) });
  }, history, "development", cloud ? "app-storage" : "local");
  if (enabled) trace.start();
  const objects = new DummyObjects();
  const store: SettingsPersistence = cloud
    ? new AppSettings(path.join(dir, "settings.json"), objects, "dummy/", () => {})
    : new LocalSettings(path.join(dir, "settings.json"), () => {});
  const app = express(); app.use("/api/settings", settingsRouter(store, trace));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/settings`;
  const get = () => fetch(base).then(r => r.json());
  const put = (bubbleMin: number, signal?: AbortSignal) => fetch(base, { method: "PUT", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: { ...defaults, bubbleMin } }) });
  return { dir, trace, events, objects, store, base, get, put,
    async close() {
      trace.stop(); server.closeIdleConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      assert.equal(server.listening, false);
      await fs.rm(dir, { recursive: true, force: true });
    } };
}

test("ダミー：GET/PUTのID・全段階・直列待ちを分離し、設定versionと順序を維持", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    assert.equal((await f.get()).version, 4);
    f.objects.hold = new Promise<void>(resolve => { release = resolve; });
    const a = f.put(21); await wait(() => f.objects.verifying);
    const get = f.get(), b = f.put(22);
    await wait(() => f.events.filter(e => e.event === "settings_trace_start").length === 4);
    await delay(60); f.objects.hold = null; release();
    assert.equal((await a).status, 200);
    assert.equal((await get).values.bubbleMin, 21);
    assert.equal((await b).status, 200);
    assert.equal((await f.get()).values.bubbleMin, 22);
    const starts = f.events.filter(e => e.event === "settings_trace_start");
    const ops = f.events.filter(e => e.event === "settings_trace_operation");
    assert.equal(new Set(starts.map(e => e.details.requestId)).size, 5);
    assert.equal(ops.length, 5);
    for (const e of starts) {
      const op = ops.find(o => o.details.requestId === e.details.requestId)!;
      const http = f.events.find(o => o.event === "settings_trace_http" && o.details.requestId === e.details.requestId)!;
      assert.equal(op.details.result, "ok"); assert.equal(http.details.result, "ok");
      assert.ok(op.details.endedAtUs >= e.details.startedAtUs);
      assert.equal(op.details.method, e.details.method);
      assert.equal(e.details.history.requests, 123);
      assert.equal(e.details.history.backfill, "running");
    }
    const puts = ops.filter(e => e.details.method === "PUT");
    for (const e of puts) {
      for (const phase of ["cloud_fetch", "local_save", "source_hash", "upload", "verification"])
        assert.equal(e.details.stages[phase].calls, 1, phase);
      assert.equal(e.details.queues.local.calls, 1);
    }
    assert.ok(ops.some(e => e.details.queues.app.ms >= 50));
    assert.equal(f.events.filter(e => e.event.startsWith("settings_trace_") &&
      ["settings_trace_start", "settings_trace_http", "settings_trace_operation"].includes(e.event)).length, 15);
    assert.ok(!JSON.stringify(f.events).includes("bubbleMin"));
  } finally { release?.(); await f.close(); }
});

test("ダミー：10秒Abort後も保存順序・再DL照合を維持し、計測停止後も最終結果を記録", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    f.objects.hold = new Promise<void>(resolve => { release = resolve; });
    const start = performance.now();
    const saving = f.put(33, AbortSignal.timeout(10000));
    // Attach rejection handler immediately, before waiting on the verification gate.
    const aborted = assert.rejects(saving, { name: "TimeoutError" });
    await wait(() => f.objects.verifying);
    await aborted;
    assert.ok(performance.now() - start >= 9900);
    await wait(() => f.events.some(e => e.event === "settings_trace_http"));
    assert.equal(f.events.find(e => e.event === "settings_trace_http")!.details.result, "client_disconnected");
    assert.equal(f.events.filter(e => e.event === "settings_trace_operation").length, 0);
    f.trace.stop();
    f.objects.hold = null; release();
    await wait(() => f.events.some(e => e.event === "settings_trace_operation"));
    const op = f.events.find(e => e.event === "settings_trace_operation")!.details;
    assert.equal(op.result, "ok"); assert.equal(op.clientDisconnected, true);
    assert.ok(op.stages.verification.ms >= 9900);
    assert.equal((await f.get()).values.bubbleMin, 33);
    assert.equal(f.events.filter(e => e.event === "settings_trace_start").length, 1);
    const runtime = f.events.filter(e => e.event === "settings_trace_runtime");
    assert.ok(runtime.length >= 1 && runtime.length <= 4);
    assert.ok(runtime.some(e => e.details.loopWindow?.maxMs >= 0));
    assert.ok(runtime.every(e => e.details.cpuCores >= 0 && e.details.windowEndUs >= e.details.windowStartUs));
  } finally { release?.(); await f.close(); }
});

test("ダミー：upload失敗とSHA不一致は失敗段階のみを記録、例外・設定・ヘッダーを記録しない", async () => {
  for (const failure of ["upload", "verification"] as const) {
    const f = await fixture();
    try {
      f.objects.fail = failure;
      assert.equal((await f.put(44)).status, 500);
      const op = f.events.find(e => e.event === "settings_trace_operation")!.details;
      assert.equal(op.result, "failed");
      assert.equal(op.stages[failure].failed, 1);
      await fetch(f.base + "?secret=NEVER_LOG_THIS_API_KEY_OR_SETTING", { method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": "NEVER_LOG_THIS_API_KEY_OR_SETTING" },
        body: '{"values":"NEVER_LOG_THIS_API_KEY_OR_SETTING"}' });
      await fetch(f.base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" });
      await wait(() => f.events.filter(e => e.event === "settings_trace_http").length === 3);
      assert.equal(f.events.filter(e => e.event === "settings_trace_operation").length, 1);
      assert.ok(!JSON.stringify(f.events).includes("NEVER_LOG_THIS"));
      assert.ok(!JSON.stringify(f.events).includes("values"));
    } finally { await f.close(); }
  }
});

test("ダミー：ローカル経路も保存・読取時間とfallbackを記録し、計測無効時は出力0", async () => {
  const on = await fixture(false), off = await fixture(false, false);
  try {
    assert.equal((await on.put(55)).status, 200); assert.equal((await off.put(55)).status, 200);
    assert.deepEqual((await on.get()).values, (await off.get()).values);
    assert.equal(on.events.find(e => e.event === "settings_trace_operation")!.details.stages.local_save.calls, 1);
    await fs.writeFile(path.join(on.dir, "settings.json"), "invalid");
    assert.equal((await on.get()).version, 4);
    assert.equal(on.events.filter(e => e.event === "settings_trace_operation").at(-1)!.details.result, "read_fallback");
    assert.equal(off.events.length, 0);
  } finally { await on.close(); await off.close(); }
});

test("ダミー：観測用loggerが失敗しても保存結果を変えない", async () => {
  const f = await fixture(false, true, true);
  try { assert.equal((await f.put(66)).status, 200); assert.equal((await f.get()).values.bubbleMin, 66); }
  finally { await f.close(); }
});

test("ダミー：同一時間窓のCPU・loop停止を検出し、履歴の余分な機密フィールドを捨てる", async () => {
  const events: Event[] = [];
  const trace = new SettingsTrace((event, details) => events.push({ event, details }), () => ({
    ...history(), backfill: "NEVER_LOG_THIS_API_KEY", apiKey: "NEVER_LOG_THIS_API_KEY",
  }));
  try {
    trace.start(); await delay(35);
    const until = performance.now() + 85; while (performance.now() < until) { /* ダミーCPU負荷 */ }
    await delay(45); trace.stop();
    const r = events.find(e => e.event === "settings_trace_runtime")!.details;
    assert.ok(r.cpuCores > 0);
    assert.ok(r.loopWindow.maxMs >= 50);
    assert.equal(r.loopWindow.windowStartUs, r.windowStartUs);
    assert.equal(r.loopWindow.windowEndUs, r.windowEndUs);
    assert.equal(r.history.backfill, "unknown");
    assert.ok(!JSON.stringify(events).includes("NEVER_LOG_THIS"));
  } finally { trace.stop(); }
});

test("ダミー：15分で自動停止し、新規受付ログと定期タイマーが止まる", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const events: Event[] = [];
  const trace = new SettingsTrace((event, details) => events.push({ event, details }), history);
  try {
    trace.start(); t.mock.timers.tick(900000);
    assert.equal(events.filter(e => e.event === "settings_trace_disabled").length, 1);
    const n = events.length; t.mock.timers.tick(600000);
    assert.equal(events.length, n);
    let nextCalled = false;
    trace.middleware({ method: "GET" } as any, {} as any, () => { nextCalled = true; });
    assert.equal(nextCalled, true); assert.equal(events.length, n);
  } finally { trace.stop(); t.mock.timers.reset(); }
});
