/** Identical dummy object delays for before/after. No production requests. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const port = Number(process.argv[2] ?? 18782), name = process.argv[3] ?? "before";
const root = `http://127.0.0.1:${port}`, result = { name, requests: [] };
const control = q => fetch(`${root}/__dummy/control?${q}`);
await control("resetLoop=1");
result.before = await (await fetch(`${root}/__dummy/status`)).json();
async function req(endpoint, method = "GET", values, timeout = 10000) {
  const begin = performance.now();
  try {
    const r = await fetch(root + endpoint, { method, signal: AbortSignal.timeout(timeout), redirect: "manual",
      ...(values ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) } : {}) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch {}
    const value = { endpoint, method, ms: performance.now() - begin, status: r.status,
      contentType: r.headers.get("content-type"), version: body?.version ?? null, error: body?.error ?? null, values: body?.values };
    result.requests.push({ ...value, values: undefined }); return value;
  } catch (e) {
    const value = { endpoint, method, ms: performance.now() - begin, error: e.name };
    result.requests.push(value); return value;
  }
}
for (const endpoint of ["/api/settings", "/api/settings/longvp"]) {
  const d = await req(endpoint); assert.ok(d.version);
  await req(endpoint, "PUT", endpoint.endsWith("/longvp") ? { ...d.values, showWeeklyVwap: false, showWeeklyCvd: false } : d.values);
}
await control("fail=1");
for (const ep of ["/api/settings", "/api/settings/longvp"]) await req(ep);
await control("fail=0&auth=redirect");
for (const ep of ["/api/settings", "/api/settings/longvp"]) await req(ep);
await control("auth=&malformed=1");
for (const ep of ["/api/settings", "/api/settings/longvp"]) await req(ep);
await control("malformed=0&delay=3500");
// Separate queues: two independent endpoint reads at once.
await Promise.all(["/api/settings", "/api/settings/longvp"].map(ep => req(ep)));
// Let the store complete after client abort; no overlapping queues in next group.
await new Promise(r => setTimeout(r, 800));
await control("delay=100");
for (const ep of ["/api/settings", "/api/settings/longvp"]) {
  const d = await req(ep);
  await req(ep, "PUT", d.values);
  await Promise.all([req(ep), req(ep)]);
}
await control("delay=0");
result.server = await (await fetch(`${root}/__dummy/status`)).json();
result.window = { cpuMs: result.server.cpuMs - result.before.cpuMs,
  elapsedMs: result.server.elapsedMs - result.before.elapsedMs, loop: result.server.loop };
await fs.mkdir("data/settings-longvp", { recursive: true });
await fs.writeFile(`data/settings-longvp/http-${name}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ name, requests: result.requests, window: result.window }));
