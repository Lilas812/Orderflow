import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, makeSanitizer } from "../src/logger.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { Upstream } from "../src/upstream/connection.ts";
import { statusSnapshot } from "../src/status/app.ts";
import { readConfig } from "../src/config.ts";

test("ダミー：ログと状態出力からキー・認証URL・key=を除去", () => {
  const secret = 'dummy-SECRET-"\\日本語';
  const lines: string[] = [];
  const log = createLogger(secret, (line) => lines.push(line), () => 123);
  const receiver = new Receiver(log);
  const upstream = new Upstream({ apiKey: secret, receiver, log });
  const url = `wss://stream.tick-stream.xyz/v1/stream?key=${encodeURIComponent(secret)}&symbols=NQ`;
  receiver.receive(JSON.stringify({ type: "warning", code: "ticks_lagged",
    message: url, nested: { [secret]: secret, "key=other": "key=other" },
  }), 123000, () => {});
  log("dummy_error", { error: new Error(url), key: secret, other: "key=unknown" });
  const status = JSON.stringify(statusSnapshot(upstream, receiver, secret));
  for (const output of [...lines, status]) {
    assert.doesNotThrow(() => JSON.parse(output));
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes(encodeURIComponent(secret)));
    assert.ok(!output.includes("dummy-SECRET"));
    assert.ok(!/key=/i.test(output));
    assert.ok(!output.includes("wss://"));
  }
  assert.equal(lines.length, 3); // warning, gap, explicit error, not per tick/book
});

test("ダミー：循環オブジェクトと改行もJSONログ1行、通常約定・板は逐次ログなし", () => {
  const lines: string[] = [];
  const log = createLogger("dummy-secret", (line) => lines.push(line));
  const circular: Record<string, unknown> = { value: "line1\nline2" };
  circular.self = circular;
  log("dummy_circular", circular);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].split("\n").length, 1);
  assert.match(lines[0], /circular/);
  const r = new Receiver(log);
  r.receive('{"type":"tick","symbol":"NQ","ts":1,"price":100,"size":1,"side":"buy"}', 1, () => {});
  r.receive('{"type":"book","symbol":"NQ","ts":1,"bids":[[100,1]],"asks":[[100.25,1]]}', 1, () => {});
  assert.equal(lines.length, 1);
  assert.equal(makeSanitizer("dummy-secret")(undefined), null);
});

test("ダミー：PORTとキーを検査し、設定エラーに環境変数の値を出さない", () => {
  assert.throws(() => readConfig({ PORT: "8080" }), /required/);
  assert.throws(() => readConfig({ TICKSTREAM_API_KEY: "dummy", PORT: "key=secret" }),
    (error: Error) => !error.message.includes("key="));
  assert.throws(() => readConfig({ TICKSTREAM_API_KEY: "dummy", PORT: "65536" }));
  assert.deepEqual(readConfig({ TICKSTREAM_API_KEY: "dummy", PORT: "8080" }),
    { apiKey: "dummy", port: 8080 });
});
