import fs from "node:fs/promises";
import { browser, waitFor, delay } from "./footprint-cdp.mjs";
const out = "data/settings-longvp";
await fs.mkdir(out, { recursive: true });
const b = await browser({ headed: true }), result = {};
try {
  const p = await b.page();
  await p.call("Page.addScriptToEvaluateOnNewDocument", { source: `window.__life=[]; for(const n of ["pageshow","pagehide"]) addEventListener(n,e=>window.__life.push({type:n,persisted:e.persisted}));` });
  await p.call("Page.navigate", { url: "http://127.0.0.1:18782/?view=longvp&debug=1" });
  await waitFor(() => p.evaluate("!!window.__longVpDebug && window.__longVpDebug.baseDraws > 1"));
  result.initial = await p.evaluate("({debug:__longVpDebug,life:__life,text:document.body.innerText})");
  await p.call("Page.navigate", { url: "http://127.0.0.1:18782/__dummy/away" });
  await delay(300);
  const history = await p.call("Page.getNavigationHistory");
  await p.call("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id });
  await delay(1200);
  result.back = await p.evaluate("({debug:window.__longVpDebug??null,life:window.__life,text:document.body.innerText})");
  await p.screenshot(`${out}/baseline-back.png`);
} finally {
  result.cleanup = await b.close();
  await fs.writeFile(`${out}/baseline.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
