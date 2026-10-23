import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { DEFAULT_LIVE_ROOT, createTrial, purgeTrial, scanExpiredTrials } from "@workspace/tickstream-storage/live-trial-directory";
import { isolatedB2, inspectCanaryRoute, privateProbe, runB2Trial } from "./gateB2Process";
import { LIVE_FLAGS } from "./gateB2Config";

const ids: string[] = [];
afterEach(() => { for (const id of ids.splice(0)) {
  try { purgeTrial(DEFAULT_LIVE_ROOT, id); } catch { /* assertion below owns any unexpected residual */ }
} });
function child(code: string) {
  return spawn(process.execPath, ["-e", code], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
}
describe("B-2B independent supervisor, restart verification and immediate purge", () => {
  it("wrong/default flags HOLD without looking at Secrets or creating a trial", async () => {
    const before = existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : [];
    const script = fileURLToPath(new URL("./gateB2Process.ts", import.meta.url));
    const p = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", script],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; p.stdout.on("data", b => { text += b; });
    await new Promise<void>(resolve => p.once("close", () => resolve()));
    expect(JSON.parse(text)).toMatchObject({ phase: "HOLD", reason: "LIVE_MODE_REQUIRED" });
    expect(existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : []).toEqual(before);
  });
  it("makes artificial canary-only probes, purges on success and refuses a 200 response", async () => {
    const before = existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : [], urls: string[] = [];
    const result = await privateProbe(DEFAULT_LIVE_ROOT, async url => { urls.push(url); return 403; }, "https://preview.test");
    expect(result).toMatchObject({ passed: true, probes: 30, remainingFiles: 0,
      privacy: { outcome: "PASS", canaryRetrievals: 0, identifierExposures: 0, unknown: 0, externalRequests: 0 } });
    expect(result.privacy.routes).toHaveLength(30);
    expect(urls.every(url => ["127.0.0.1", "preview.test"].includes(new URL(url).hostname) && url.includes("privacy-canary"))).toBe(true);
    expect(result.privacy.routes.filter(r => r.group === "existing")).toHaveLength(6);
    expect(result.privacy.routes.filter(r => r.group !== "existing")).toHaveLength(24);
    await expect(privateProbe(DEFAULT_LIVE_ROOT, async () => 200, "https://preview.test")).rejects.toThrow("B2_PRIVATE_PROBE_FAILED");
    expect(readdirSync(DEFAULT_LIVE_ROOT)).toEqual(before);
  });
  it("requires an in-process privacy proof before even considering a production run", async () => {
    await expect(runB2Trial("PRODUCTION", "ARTIFICIAL_KEY_NEVER_USED", {})).rejects.toMatchObject({ code: "B2_PRIVATE_PROBE_FAILED" });
  });
  it("faulted connection policy HOLDs before key access, network IO or child launch, even with all live flags", async () => {
    const before = existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : [];
    // In-memory test-only fault injection. No product file is rewritten, and the
    // subprocess has an EMPTY env plus traps which forbid any key/network access.
    const preload = `
      import {registerHooks,syncBuiltinESMExports} from 'node:module';
      import net from 'node:net'; import cp from 'node:child_process';
      let secretReads=0,networkAttempts=0,childLaunches=0;
      process.env=new Proxy(process.env,{get(t,k){
        if(k==='TICKSTREAM_API_KEY'){secretReads++;throw Error('ARTIFICIAL_SECRET_READ_FORBIDDEN')}
        return Reflect.get(t,k);
      }});
      net.Socket.prototype.connect=function(){networkAttempts++;throw Error('ARTIFICIAL_NETWORK_FORBIDDEN')};
      cp.fork=function(){childLaunches++;throw Error('ARTIFICIAL_CHILD_FORBIDDEN')};
      syncBuiltinESMExports();
      registerHooks({load(url,ctx,next){
        const r=next(url,ctx);
        if(url.endsWith('/gateB2Config.ts')){
          const source=typeof r.source==='string'?r.source:Buffer.from(r.source).toString();
          const expected='effectiveReconnectLimit: 0, maxConnectionAttempts: 1';
          if(!source.includes(expected))throw Error('ARTIFICIAL_FAULT_HOOK_FAILED');
          return {...r,source:source.replace(expected,'effectiveReconnectLimit: 1, maxConnectionAttempts: 1')};
        }
        return r;
      }});
      process.on('exit',()=>process.stderr.write(JSON.stringify({secretReads,networkAttempts,childLaunches})));
    `;
    const script = fileURLToPath(new URL("./gateB2Process.ts", import.meta.url));
    const p = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      "--experimental-transform-types", "--disable-warning=ExperimentalWarning", script, ...LIVE_FLAGS],
    { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", b => { stdout += b; }); p.stderr.on("data", b => { stderr += b; });
    const code = await new Promise<number | null>(resolve => p.once("close", resolve));
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ phase: "HOLD", reason: "B2_CONNECTION_POLICY_HOLD" });
    expect(JSON.parse(stderr)).toEqual({ secretReads: 0, networkAttempts: 0, childLaunches: 0 });
    expect(existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : []).toEqual(before);
  });
  it("reports malformed IPC as a fixed code, never a raw secret/URL", async () => {
    const r = await isolatedB2({ spawn: () => child(`process.on("message",m=>{
      if(m.type==="START")process.send({type:"RESULT",value:{raw:"ARTIFICIAL_KEY_SENTINEL"}});
      if(m.type==="STOP")process.exit(1);
    });`), decode: () => null, budgetMs: 3000, cleanupMs: 100 });
    expect(r.reason).toBe("B2_IPC_INVALID"); expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
  it("terminates an unresponsive event loop independently and waits for exit", async () => {
    const r = await isolatedB2({ spawn: () => child(`process.on("SIGTERM",()=>{});
      process.on("message",m=>{if(m.type==="START")Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`),
    decode: () => null, budgetMs: 300, cleanupMs: 100 });
    expect(r.forced).toBe(true); expect(r.result).toBeNull(); expect(r.reason).toMatch(/WALL_TIME_LIMIT|FORCED_TERMINATION/);
    expect(r.childRssPeak).toBeGreaterThan(0); expect(r.totalRssPeak).toBeGreaterThan(r.childRssPeak!);
  });
  it("never permits watchdog/cleanup limits larger than approved budgets", async () => {
    let called = false;
    await expect(isolatedB2({ spawn: () => { called = true; return child(""); }, decode: () => null,
      budgetMs: 120001 })).rejects.toThrow("B2_UNSAFE_BUDGET");
    expect(called).toBe(false);
  });
  it("does not retry a failed child creation", async () => {
    let attempts = 0;
    const r = await isolatedB2({ spawn: () => { attempts++; throw Error("ARTIFICIAL_SPAWN_FAILURE"); }, decode: () => null });
    expect(attempts).toBe(1); expect(r.reason).toBe("B2_CHILD_FAILURE"); expect(r.result).toBeNull();
  });
  it.each([1, 2, 3])("does not fabricate MEMORY_NOT_MEASURED when a validated child exits immediately (%s)", async () => {
    const r = await isolatedB2({ spawn: () => child(`process.on("message",m=>{
      if(m.type==="START")process.send({type:"RESULT",value:{done:true}},()=>process.exit(0));});`),
    decode: v => (v as { done?: unknown })?.done === true ? { done: true } : null, budgetMs: 3000, cleanupMs: 100 });
    expect(r.reason).toBeNull(); expect(r.result).toEqual({ done: true });
    expect(r.childRssPeak).toBeGreaterThan(0); expect(r.totalRssPeak).toBeGreaterThan(0);
  });
  it("writes in one empty-env Node, fully verifies in a different Node, immediately purges only that trial", async () => {
    const other = createTrial(DEFAULT_LIVE_ROOT, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST"); ids.push(other.trialId);
    const otherMarker = readFileSync(`${other.directory}/trial.json`, "utf8");
    let start: { trialId: string; captureMode: string; deleteByMs: number } | undefined;
    const r = await runB2Trial("ARTIFICIAL_PROTOCOL_TEST", undefined, undefined, info => {
      start = info;
      expect(existsSync(`${DEFAULT_LIVE_ROOT}/${info.trialId}/trial.json`)).toBe(true);
      expect(readdirSync(`${DEFAULT_LIVE_ROOT}/${info.trialId}/data`)).toEqual([]);
    });
    expect(r.phase, JSON.stringify(r)).toBe("COMPLETED");
    expect(start?.trialId).toBe(r.trialId); expect(start?.captureMode).toBe("ARTIFICIAL_PROTOCOL_TEST");
    expect(start?.deleteByMs).toBeGreaterThan(Date.now());
    expect(r.capture?.storage).toMatchObject({ persisted: 2, pending: 0, unknown: 0, accountingMatches: true });
    expect(r.recovery).toMatchObject({ status: "VERIFIED", manifestCount: 2, logCount: 2, finalCommitPosition: 2 });
    expect(r.recovery?.head).toBe(r.capture?.commit.head);
    expect(r.recovery?.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cleanup).toMatchObject({ deleted: true, remainingFiles: 0, trialId: r.trialId });
    expect(existsSync(`${DEFAULT_LIVE_ROOT}/${r.trialId}`)).toBe(false);
    expect(readFileSync(`${other.directory}/trial.json`, "utf8")).toBe(otherMarker);
    expect(r.deletionWhileStopped).toBe("NOT_GUARANTEED_MANUAL_CONFIRMATION_REQUIRED");
  });
  it("detects an expired trial without parsing it and prevents new capture until explicit purge", async () => {
    const p = createTrial(DEFAULT_LIVE_ROOT, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST", Date.now() - 100, 1); ids.push(p.trialId);
    expect(scanExpiredTrials()).toContain(p.trialId);
    await expect(runB2Trial("ARTIFICIAL_PROTOCOL_TEST")).rejects.toMatchObject({ code: "TRIAL_EXPIRED_CLEANUP_REQUIRED" });
    expect(existsSync(p.directory)).toBe(true);
  });
});

describe("B-2B artificial canary body classification and bounded redirects", () => {
  const html = "<!DOCTYPE html><html><head><title>ARTIFICIAL SPA</title></head><body><div id=\"root\"></div></body></html>";
  const token = "ARTIFICIAL_PRIVATE_IDENTIFIER";
  const canary = `ARTIFICIAL_CANARY_${token}`;
  const input = { url: "http://127.0.0.1/canary", baselineUrl: "http://127.0.0.1/",
    previewOrigin: "https://preview.test", canary, identifiers: [token] };
  const response = (body: string, status = 200, type = "text/html", headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { "content-type": type, ...headers } });
  it.each([403, 404])("accepts denial only after checking its body (%s)", async status => {
    const r = await inspectCanaryRoute(input, async () => response("denied", status, "text/plain"));
    expect(r).toMatchObject({ outcome: "PASS", reason: "EXPLICIT_DENIAL", bodyMatch: false, identifierExposed: false });
  });
  it("accepts a 200 ONLY when it matches the normal mount HTML", async () => {
    let calls = 0;
    const r = await inspectCanaryRoute(input, async () => { calls++; return response(html); });
    expect(r).toMatchObject({ outcome: "PASS", reason: "MATCHED_NORMAL_HTML", contentType: "text/html",
      spaFallback: true, bodyMatch: false, identifierExposed: false });
    expect(calls).toBe(2);
  });
  it.each(["text/plain", "application/octet-stream", "application/json", ""])(
    "does not mistake non-HTML content for an SPA (%s)", async type => {
      expect(await inspectCanaryRoute(input, async () => response(html, 200, type)))
        .toMatchObject({ outcome: "UNKNOWN", reason: "UNCLASSIFIED_RESPONSE" });
    });
  it.each([200, 403, 404, 307])("rejects canary bytes even with status %s", async status => {
    expect(await inspectCanaryRoute(input, async () => response(canary, status, "text/plain", { location: "/denied" })))
      .toMatchObject({ outcome: "FAIL", reason: "CANARY_EXPOSED", bodyMatch: true, identifierExposed: true });
  });
  it("rejects a partial identifier inside ordinary-looking HTML and redacts reports", async () => {
    const r = await inspectCanaryRoute(input, async () => response(html.replace("</body>", `${token}</body>`)));
    expect(r).toMatchObject({ outcome: "FAIL", identifierExposed: true });
    expect(JSON.stringify(r)).not.toContain(token); expect(JSON.stringify(r)).not.toContain(input.url);
  });
  it("rejects downloads even when content-type says HTML", async () => {
    expect(await inspectCanaryRoute(input, async () => response(html, 200, "text/html", { "content-disposition": "attachment" })))
      .toMatchObject({ outcome: "UNKNOWN", reason: "UNCLASSIFIED_RESPONSE" });
  });
  it("does not trust unrelated HTML or a baseline redirect", async () => {
    for (const baseline of [() => response(html.replace("SPA", "OTHER")),
      () => response("", 307, "text/html", { location: "https://external.test" })]) {
      expect(await inspectCanaryRoute(input, async url => url.endsWith("/canary") ? response(html) : baseline()))
        .toMatchObject({ outcome: "UNKNOWN", reason: "HTML_BASELINE_MISMATCH" });
    }
  });
  it("detects a canary exposed by the baseline too", async () => {
    expect(await inspectCanaryRoute(input, async url => response(url.endsWith("/canary") ? html : canary)))
      .toMatchObject({ outcome: "FAIL", reason: "CANARY_EXPOSED" });
  });
  it("follows at most three allowed redirects, checking every body", async () => {
    const urls: string[] = [];
    const r = await inspectCanaryRoute(input, async url => {
      urls.push(url);
      return urls.length <= 3 ? response("", 307, "text/plain", { location: `/hop-${urls.length}` }) : response("denied", 404);
    });
    expect(r).toMatchObject({ outcome: "PASS", initialStatus: 307, finalStatus: 404, redirects: 3 });
    expect(urls).toHaveLength(4);
  });
  it("does not send a fourth redirect request", async () => {
    let calls = 0;
    const r = await inspectCanaryRoute(input, async () => response("", 307, "text/plain", { location: `/hop-${++calls}` }));
    expect(r).toMatchObject({ outcome: "UNKNOWN", reason: "REDIRECT_LIMIT", redirects: 3 });
    expect(calls).toBe(4);
  });
  it.each(["https://external.test/canary", "https://preview.test.evil.test/canary", "file:///tmp/canary",
    "ftp://127.0.0.1/canary", "http://user:password@localhost/canary", "http://localhost/canary?key=ARTIFICIAL"])(
    "blocks a forbidden destination before requesting it (%s)", async location => {
      let calls = 0;
      const r = await inspectCanaryRoute(input, async () => { calls++; return response("", 307, "text/plain", { location }); });
      expect(r).toMatchObject({ outcome: "FAIL", reason: "DESTINATION_FORBIDDEN", externalRedirectsBlocked: 1 });
      expect(calls).toBe(1);
    });
  it("allows only the exact explicitly selected preview origin", async () => {
    const urls: string[] = [];
    const r = await inspectCanaryRoute(input, async url => {
      urls.push(url); return urls.length === 1 ? response("", 307, "text/plain", { location: "https://preview.test/denied" }) : response("", 403);
    });
    expect(r).toMatchObject({ outcome: "PASS", redirects: 1 });
    expect(urls).toEqual([input.url, "https://preview.test/denied"]);
  });
  it("fails a redirect loop without sending the repeated request", async () => {
    let calls = 0;
    expect(await inspectCanaryRoute(input, async () => {
      calls++; return response("", 307, "text/plain", { location: input.url });
    })).toMatchObject({ outcome: "FAIL", reason: "REDIRECT_LOOP" });
    expect(calls).toBe(1);
  });
  it("keeps missing or invalid redirect targets UNKNOWN", async () => {
    const targets: Record<string, string>[] = [{}, { location: "http://[" }];
    for (const headers of targets) {
      expect((await inspectCanaryRoute(input, async () => response("", 307, "text/plain", headers))).outcome).toBe("UNKNOWN");
    }
  });
  it("detects an identifier in Location without following it", async () => {
    let calls = 0;
    expect(await inspectCanaryRoute(input, async () => {
      calls++; return response("", 307, "text/plain", { location: `/reflect/${token}` });
    })).toMatchObject({ outcome: "FAIL", reason: "CANARY_IDENTIFIER_IN_HEADERS", identifierExposed: true });
    expect(calls).toBe(1);
  });
  it("rejects identifier exposure in headers even on explicit denial", async () => {
    expect(await inspectCanaryRoute(input, async () => response("", 403, "text/plain", { "x-artificial": token })))
      .toMatchObject({ outcome: "FAIL", reason: "CANARY_IDENTIFIER_IN_HEADERS", identifierExposed: true });
  });
  it("fails fragment-only loops before repeating a request", async () => {
    let calls = 0;
    expect(await inspectCanaryRoute(input, async () => {
      calls++; return response("", 307, "text/plain", { location: "#fragment" });
    })).toMatchObject({ outcome: "FAIL", reason: "REDIRECT_LOOP" });
    expect(calls).toBe(1);
  });
  it("checks the final redirected body for exposure", async () => {
    let calls = 0;
    expect(await inspectCanaryRoute(input, async () => ++calls === 1
      ? response("", 307, "text/plain", { location: "/target" }) : response(canary, 200, "text/plain")))
      .toMatchObject({ outcome: "FAIL", reason: "CANARY_EXPOSED", redirects: 1 });
  });
  it("bounds response memory and refuses incomplete/unavailable bodies", async () => {
    expect((await inspectCanaryRoute(input, async () => response("x".repeat(1024 * 1024 + 1)))).outcome).toBe("UNKNOWN");
    expect((await inspectCanaryRoute(input, async () => { throw Error("ARTIFICIAL_IO"); })).outcome).toBe("UNKNOWN");
  });
  it("requires an explicit preview origin and deletes the artificial trial on UNKNOWN", async () => {
    const before = readdirSync(DEFAULT_LIVE_ROOT);
    await expect(privateProbe(DEFAULT_LIVE_ROOT, async () => 403, ""))
      .rejects.toMatchObject({ code: "B2_PRIVATE_PROBE_FAILED", privacy: { outcome: "UNKNOWN", unknown: 12 } });
    expect(readdirSync(DEFAULT_LIVE_ROOT)).toEqual(before);
  });
  it("deletes only its artificial trial on FAIL, preserving other trials", async () => {
    const other = createTrial(DEFAULT_LIVE_ROOT, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST"); ids.push(other.trialId);
    const before = readdirSync(DEFAULT_LIVE_ROOT), marker = readFileSync(`${other.directory}/trial.json`, "utf8");
    await expect(privateProbe(DEFAULT_LIVE_ROOT, async url => {
      const path = decodeURIComponent(new URL(url).pathname.replace(/^\/@fs\/?/, "/"));
      return response(readFileSync(path, "utf8"), 200, "text/plain");
    }, "https://preview.test")).rejects.toMatchObject({ privacy: { outcome: "FAIL" } });
    expect(readdirSync(DEFAULT_LIVE_ROOT)).toEqual(before);
    expect(readFileSync(`${other.directory}/trial.json`, "utf8")).toBe(marker);
  });
  it("uses real loopback HTTP with manual redirects and no credentials or cookies", async () => {
    const received: { url: string; auth: string | undefined; cookie: string | undefined }[] = [];
    const server = createServer((req, res) => {
      received.push({ url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie });
      if (req.url === "/canary") { res.writeHead(307, { location: "/normal", "set-cookie": "ARTIFICIAL=1" }); res.end(); }
      else { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const r = await inspectCanaryRoute({ ...input, url: `${origin}/canary`, baselineUrl: `${origin}/` });
      expect(r).toMatchObject({ outcome: "PASS", initialStatus: 307, finalStatus: 200, redirects: 1, spaFallback: true });
      expect(received).toEqual(["/canary", "/normal", "/"].map(url => ({ url, auth: undefined, cookie: undefined })));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
