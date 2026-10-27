import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { storageMode } from "../src/store/objects.ts";

const heatmap = readFileSync(new URL("../../artifacts/heatmap/.replit-artifact/artifact.toml", import.meta.url), "utf8");
const api = readFileSync(new URL("../../artifacts/api-server/.replit-artifact/artifact.toml", import.meta.url), "utf8");

// These declarations use JSON-compatible TOML string/array literals. This is a
// focused regression guard, not a replacement for platform schema validation.
function entry(section: string, key: string): unknown {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  assert.ok(match, `missing configuration entry: ${key}`);
  return JSON.parse(match[1]);
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading + "\n");
  assert.notEqual(start, -1, `missing configuration section: ${heading}`);
  return text.slice(start + heading.length + 1).split(/^\[/m)[0];
}

test("HTTPとWebSocketの公開経路をheatmapだけに登録する", () => {
  assert.equal(heatmap.split("[[services]]").length - 1, 1);
  const service = section(heatmap, "[[services]]");
  assert.deepEqual(entry(service, "paths"), ["/", "/api", "/api/ws"]);
  assert.equal(entry(service, "localPort"), 25028);
  assert.deepEqual(entry(api, "services"), []);
  assert.equal(api.includes("[[services]]"), false);
});

test("開発も公開も同じビルド済み画面と単一の受信プロセスを起動する", () => {
  const build = entry(section(heatmap, "[services.production]"), "build") as string[];
  const start = entry(section(heatmap, "[services.production]"), "run") as string[];
  assert.equal(build.join(" "), "pnpm --filter @workspace/receiver run build");
  assert.equal(start.join(" "), "pnpm --filter @workspace/receiver run start");
  assert.equal(entry(section(heatmap, "[services.development]"), "run"),
    `${build.join(" ")} && ${start.join(" ")}`);
  assert.equal(entry(section(heatmap, "[services.env]"), "PORT"), "25028");
  assert.equal(entry(section(heatmap, "[services.env]"), "BASE_PATH"), "/");
  assert.equal(entry(section(heatmap, "[services.production.health.startup]"), "path"), "/api/healthz");
  assert.equal(/^\s*paths\s*=/m.test(section(heatmap, "[services.production]")), false);
});

test("同じ本番用コマンドでもWorkspaceはローカル保存、公開先はprodへ分離する", () => {
  assert.deepEqual(storageMode({ NODE_ENV: "production" }), { app: false, prefix: "dev/" });
  assert.deepEqual(storageMode({ NODE_ENV: "production", REPLIT_DEPLOYMENT: "1" }),
    { app: true, prefix: "prod/" });
});
