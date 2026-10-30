import { test } from "node:test";
import assert from "node:assert/strict";
import { requestSettingsDocument } from "../src/data/settings-request.ts";
const parse = (raw: unknown) => (raw as { version?: number })?.version === 1 ? raw : null;
test("ダミー: redirect・HTML・HTTP失敗・version不一致を初期値や自動PUTにしない", async () => {
  const original = globalThis.fetch, calls: string[] = [];
  try {
    for (const [response, pattern] of [
      [() => { const r = new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } });
        Object.defineProperty(r, "redirected", { value: true }); return r; }, /リダイレクト/],
      [() => new Response("<html>proxy error</html>", { status: 502, headers: { "Content-Type": "text/html" } }), /JSONではありません.*502/],
      [() => Response.json({ error: "settings_read_failed" }, { status: 500 }), /HTTP 500/],
      [() => Response.json({ error: "forbidden" }, { status: 403 }), /HTTP 403/],
      [() => Response.json({ version: 99 }), /version/],
    ] as const) {
      globalThis.fetch = (async (_url, init) => { calls.push(init?.method ?? "GET"); return response(); }) as typeof fetch;
      await assert.rejects(requestSettingsDocument("/dummy", undefined, parse), pattern);
    }
    assert.deepEqual(calls, ["GET", "GET", "GET", "GET", "GET"]);
    globalThis.fetch = (async () => Response.json({ version: 1 })) as typeof fetch;
    assert.deepEqual(await requestSettingsDocument("/dummy", undefined, parse), { version: 1 });
    globalThis.fetch = (async () => {
      const r = Response.json({ version: 1 });
      Object.defineProperty(r, "redirected", { value: true }); return r;
    }) as typeof fetch;
    assert.deepEqual(await requestSettingsDocument("/dummy", undefined, parse), { version: 1 });
  } finally { globalThis.fetch = original; }
});
