import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_DISPLAY_SETTINGS, MAX_SETTINGS_BYTES } from "@workspace/core/settings-schema";
import { createSettingsMiddleware } from "./settingsMiddleware";
import { SettingsFileStore } from "./settingsFileStore";

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
async function setup(base = "/") {
  const dir = await mkdtemp(path.join(tmpdir(), "orderflow-http-")); clean.push(() => rm(dir, { recursive: true, force: true }));
  const handler = createSettingsMiddleware(new SettingsFileStore(dir), base);
  const server: Server = createServer((req, res) => { void handler(req, res, () => { res.statusCode = 404; res.end("not settings"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  clean.push(() => new Promise<void>((resolve, reject) => { server.close(err => err ? reject(err) : resolve()); server.closeAllConnections(); }));
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}${base.replace(/\/$/, "")}/__orderflow/settings`;
  const loaded = await fetch(url), body = await loaded.json();
  const headers = { Origin: origin, "Content-Type": "application/json", "X-Settings-CSRF": body.csrfToken };
  const payload = JSON.stringify({ expectedRevision: 0, settings: DEFAULT_DISPLAY_SETTINGS });
  return { origin, url, headers, payload, dir, body, loaded };
}
describe("R13 fixed settings-only HTTP boundary", () => {
  it("GET is no-store, distinguishes defaults and provides a non-persisted CSRF token", async () => {
    const { body, loaded } = await setup();
    expect(body.persisted).toBe(false); expect(body.revision).toBe(0);
    expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.headers.get("cache-control")).toBe("no-store");
    expect(loaded.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("PUT succeeds for strict settings, strips token from disk and restores via GET", async () => {
    const { url, headers, payload, dir } = await setup();
    const res = await fetch(url, { method: "PUT", headers, body: payload });
    expect(res.status).toBe(200); expect((await res.json()).revision).toBe(1);
    const raw = await readFile(path.join(dir, "display.v1.json"), "utf8");
    expect(raw).not.toContain("csrfToken"); expect(raw).not.toContain(headers["X-Settings-CSRF"]);
    expect((await (await fetch(url)).json()).persisted).toBe(true);
  });
  it("requires same-origin and CSRF before writes, including malformed Unicode tokens", async () => {
    const { url, origin, headers, payload } = await setup();
    const invalid: Record<string, string>[] = [{ Origin: "https://evil.example" }, { Origin: "null" },
      { Origin: origin.replace("http:", "https:") }, { Origin: origin + "/not-an-origin" },
      { Origin: "" }, { "X-Settings-CSRF": "" }, { "X-Settings-CSRF": "é".repeat(64) },
      { "Sec-Fetch-Site": "cross-site" }];
    for (const overrides of invalid) {
      expect((await fetch(url, { method: "PUT", headers: { ...headers, ...overrides }, body: payload })).status).toBe(403);
    }
    expect((await (await fetch(url)).json()).revision).toBe(0);
  });
  it("rejects cross-site GET and preflight without enabling CORS", async () => {
    const { url } = await setup();
    expect((await fetch(url, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(url, { method: "OPTIONS" })).status).toBe(405);
  });
  it("rejects wrong MIME, bad JSON and arbitrary path injection", async () => {
    const { url, headers, payload } = await setup();
    expect((await fetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "text/plain" }, body: payload })).status).toBe(415);
    expect((await fetch(url, { method: "PUT", headers, body: "{" })).status).toBe(400);
    expect((await fetch(url, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 0, settings: DEFAULT_DISPLAY_SETTINGS, path: "/etc/passwd" }) })).status).toBe(400);
    expect((await fetch(url + "?path=/etc/passwd")).status).toBe(400);
  });
  it("rejects >64KiB request and subsequent requests still work", async () => {
    const { url, headers, payload } = await setup();
    expect((await fetch(url, { method: "PUT", headers, body: " ".repeat(MAX_SETTINGS_BYTES + 1) })).status).toBe(413);
    expect((await fetch(url, { method: "PUT", headers, body: payload })).status).toBe(200);
  });
  it("rejects schema/quantity violations at the HTTP boundary", async () => {
    const { url, headers } = await setup();
    const s = JSON.parse(JSON.stringify(DEFAULT_DISPLAY_SETTINGS)); s.heatmap.scale.minimumVolume = 1.5;
    expect((await fetch(url, { method: "PUT", headers, body: JSON.stringify({ settings: s, expectedRevision: 0 }) })).status).toBe(400);
    expect((await (await fetch(url)).json()).persisted).toBe(false);
  });
  it("handles simultaneous HTTP saves by optimistic revision conflict", async () => {
    const { url, headers, payload } = await setup();
    const results = await Promise.all([fetch(url, { method: "PUT", headers, body: payload }), fetch(url, { method: "PUT", headers, body: payload })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it("honors an artifact base path; root and arbitrary file paths are not handled", async () => {
    const { origin, url, headers, payload } = await setup("/orderflow/");
    expect((await fetch(url, { method: "PUT", headers, body: payload })).status).toBe(200);
    expect((await fetch(origin + "/__orderflow/settings")).status).toBe(404);
    expect((await fetch(origin + "/orderflow/settingsFileStore.ts")).status).toBe(404);
  });
});
