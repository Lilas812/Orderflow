/** Focused native-tab/BFCache follow-up to the live isolated acceptance pass. */
import fs from "node:fs/promises";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";

const root = "http://127.0.0.1:18783";
const out = "data/settings-longvp/ui";
await fs.mkdir(out, { recursive: true });
const result = { fixture: root, onlyNativeFollowup: true, lifecycle: [], polls: [] };
const b = await browser({ headed: true });
try {
  const p = await b.page();
  await p.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__life=[]; for(const n of ["pageshow","pagehide"]) addEventListener(n,e=>window.__life.push({type:n,persisted:e.persisted,at:Date.now()}));`,
  });
  await p.call("Page.navigate", { url: `${root}/?view=longvp&debug=1` });
  await waitFor(() => p.evaluate("!!window.__longVpDebug && window.__longVpDebug.profiles?.[0]?.total === 81"), 15000);
  result.initial = await p.evaluate(`({url:location.href,hidden:document.hidden,text:document.body.innerText,debug:window.__longVpDebug,life:window.__life})`);
  const status = async () => (await (await fetch(`${root}/__dummy/status`)).json());
  const countToday = async () => (await status()).requests.filter(r => r.path === "/today").length;
  result.initialStatus = await status();
  await p.screenshot(`${out}/native-before.png`);

  const beforeHiddenPollCount = await countToday();
  const away = await b.page(`${root}/__dummy/away`, true);
  await away.front();
  result.nativeTab = {
    awayUrl: await away.evaluate("location.href"),
    mainHidden: await p.evaluate("document.hidden"),
    awayHidden: await away.evaluate("document.hidden"),
  };
  let duePoll = null;
  const until = Date.now() + 75000;
  while (Date.now() < until) {
    const s = await status();
    const rows = s.requests.filter(r => r.path === "/today");
    if (rows.length > beforeHiddenPollCount) { duePoll = rows.at(-1); result.hiddenStatus = s; break; }
    await delay(1000);
  }
  if (!duePoll) {
    result.hiddenPoll = { frozenOrMissing: true };
    await p.front();
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const s = await status(), rows = s.requests.filter(r => r.path === "/today");
      if (rows.length > beforeHiddenPollCount) { duePoll = rows.at(-1); result.hiddenStatus = s; break; }
      await delay(1000);
    }
  }
  if (duePoll) {
    result.hiddenPoll = {
      request: duePoll,
      elapsedUsFromPrior: (() => {
        const xs = result.hiddenStatus.requests.filter(r => r.path === "/today");
        return xs.length > 1 ? xs.at(-1).atUs - xs.at(-2).atUs : null;
      })(),
      mainHiddenAtObservation: await p.evaluate("document.hidden"),
      debug: await p.evaluate("({profiles:window.__longVpDebug?.profiles,built:window.__longVpDebug?.todayBuiltAtUs})"),
    };
  }

  await p.front();
  await away.close();
  await waitFor(() => p.evaluate("!document.hidden"), 5000);
  result.beforeBack = await p.evaluate("({url:location.href,hidden:document.hidden,debug:window.__longVpDebug,life:window.__life})");
  await p.call("Page.navigate", { url: `${root}/__dummy/away` });
  await waitFor(() => p.evaluate(`location.pathname === "/__dummy/away"`), 10000);
  const history = await p.call("Page.getNavigationHistory");
  const previous = history.entries[history.currentIndex - 1];
  await p.call("Page.navigateToHistoryEntry", { entryId: previous.id });
  await waitFor(() => p.evaluate("!!window.__longVpDebug && window.__longVpDebug.profiles?.[0]?.total === 81"), 15000);
  result.back = await p.evaluate(`({url:location.href,text:document.body.innerText,label:document.body.innerText.includes("ダミー隔離"),hidden:document.hidden,debug:window.__longVpDebug,life:window.__life})`);
  result.lifecycle = result.back.life ?? [];
  await p.screenshot(`${out}/native-after-back.png`);

  const preReloadCount = await countToday();
  const preReloadTotal = result.back.debug.profiles?.[0]?.total;
  await p.call("Page.reload");
  await waitFor(() => p.evaluate("!!window.__longVpDebug && window.__longVpDebug.profiles?.[0]?.total === 81"), 15000);
  result.reload = await p.evaluate(`({url:location.href,text:document.body.innerText,label:document.body.innerText.includes("ダミー隔離"),debug:window.__longVpDebug,life:window.__life})`);
  const reloadStatus = await status();
  result.reloadServer = {
    requestCount: reloadStatus.requests.filter(r => r.path === "/today").length,
    reloadRequest: reloadStatus.requests.filter(r => r.path === "/today").at(-1),
    NQ: reloadStatus.totals.NQ.bars1m?.[0]?.[5],
    GC: reloadStatus.totals.GC.bars1m?.[0]?.[5],
    cloudWrites: reloadStatus.cloudWrites,
    noWebSocketPeersExpected: true,
  };
  result.reloadNoDouble = { priorProfileTotal: preReloadTotal, afterProfileTotal: result.reload.debug.profiles?.[0]?.total, serverTotal: result.reloadServer.NQ, preReloadRequestCount: preReloadCount };
  await p.screenshot(`${out}/native-after-reload.png`);
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  result.cleanup = await b.close();
  try { process.kill(result.cleanup.pid, 0); result.cleanup.pidAbsent = false; }
  catch (e) { result.cleanup.pidAbsent = e.code === "ESRCH"; }
  result.successChecks = {
    hidden: result.nativeTab?.mainHidden === true,
    hiddenPoll: !!result.hiddenPoll?.request,
    persistedBack: result.lifecycle?.some(x => x.type === "pageshow" && x.persisted === true),
    restoredContent: result.back?.label === true && result.back?.debug?.profiles?.[0]?.total === 81,
    noDoubleAfterReload: result.reloadNoDouble?.afterProfileTotal === 81 && result.reloadNoDouble?.serverTotal === 81,
    browserExited: result.cleanup?.exited === true && result.cleanup?.pidAbsent === true,
  };
  const primaryPath = `${out}/primary.json`;
  try {
    const primary = JSON.parse(await fs.readFile(primaryPath, "utf8"));
    primary.nativeFollowup = result;
    await fs.writeFile(`${out}/result.json`, JSON.stringify(primary, null, 2));
  } catch { await fs.writeFile(`${out}/result.json`, JSON.stringify(result, null, 2)); }
  await fs.writeFile(`${out}/native-followup.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ file: `${out}/result.json`, native: result.nativeTab, hiddenPoll: result.hiddenPoll, back: result.back ? { label: result.back.label, profile: result.back.debug?.profiles, life: result.lifecycle } : null, reloadNoDouble: result.reloadNoDouble, cleanup: result.cleanup, checks: result.successChecks }));
