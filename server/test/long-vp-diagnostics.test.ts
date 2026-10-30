import test from "node:test";
import assert from "node:assert/strict";
import { LongVpDiagnostics } from "../src/long-vp/diagnostics.ts";

test("診断：run・入れ子段階・5分待機を銘柄付きで追跡し、終了後は記録しない", async () => {
  let now = 0, release!: () => void, contexts = 0;
  const rows: { event: string; details: any }[] = [];
  const diagnostic = new LongVpDiagnostics("GC", (event, details) => rows.push({ event, details }),
    () => { contexts++; return { seamReady: true, backfillState: "complete", vpHistoryState: "running" }; },
    () => now);
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const job = diagnostic.run(() => diagnostic.stage("today_restore", { date: "2026-10-29" },
    () => diagnostic.stage("build", { startSec: 10, endSec: 20 }, () => blocked)));
  diagnostic.waiting();
  now = 299999; diagnostic.waiting();
  assert.equal(contexts, 0);
  now = 300000; diagnostic.waiting(); diagnostic.waiting();
  assert.equal(contexts, 1);
  const waiting = rows.filter(r => r.event === "long_vp_stage_waiting");
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].details.stage, "build");
  assert.equal(waiting[0].details.vpHistoryState, "running");
  assert.equal(waiting[0].details.startSec, 10);
  now = 600000; diagnostic.waiting();
  assert.equal(contexts, 2);
  release(); await job;
  assert.deepEqual(rows.filter(r => r.event === "long_vp_stage_finished").map(r => r.details.stage),
    ["build", "today_restore"]);
  const runId = rows[0].details.runId;
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.ok(rows.every(r => r.details.symbol === "GC" && r.details.runId === runId));
  assert.equal(rows.at(-1)!.details.outcome, "complete");
  const count = rows.length;
  now += 300000; diagnostic.waiting();
  assert.equal(rows.length, count);
  await diagnostic.run(async () => {});
  assert.notEqual(rows.at(-1)!.details.runId, runId);
});

test("診断：例外は同じオブジェクトを再送出し、生の例外・payloadを記録しない", async () => {
  const rows: { event: string; details: any }[] = [];
  const diagnostic = new LongVpDiagnostics("NQ", (event, details) => rows.push({ event, details }), () => ({}));
  const error = Error("DUMMY-secret-url-and-payload");
  await assert.rejects(diagnostic.run(() => diagnostic.stage("metadata", {},
    async () => { throw error; })), e => e === error);
  assert.equal(rows.find(r => r.event === "long_vp_stage_finished")!.details.outcome, "failed");
  assert.equal(rows.at(-1)!.details.outcome, "failed");
  assert.ok(!JSON.stringify(rows).includes(error.message));
});

test("診断：観測writerや待機状態取得の失敗は元の処理・戻り値を変えない", async () => {
  let now = 0, release!: () => void;
  const diagnostic = new LongVpDiagnostics("NQ", () => { throw Error("DUMMY-log-failure"); },
    () => { throw Error("DUMMY-context-failure"); }, () => now);
  const blocked = new Promise<number>(resolve => { release = () => resolve(7); });
  const job = diagnostic.run(() => diagnostic.stage("ready", {}, () => blocked));
  now = 300000;
  assert.doesNotThrow(() => diagnostic.waiting());
  release(); assert.equal(await job, 7);
});
