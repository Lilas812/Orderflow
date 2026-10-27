import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import * as fs from "node:fs/promises";
import path from "node:path";
import { browser, delay } from "./cdp.ts";
import { staticProxy } from "./static-proxy.ts";

const root = path.resolve("data/perf-memory/transport-probe");
await fs.mkdir(root, { recursive: true });
const html = `<h1>ダミー WebSocket通信経路検証</h1><script>
window.result={}; const socket=new WebSocket('ws://'+location.host+'/api/ws');
socket.onopen=()=>{window.result.open=true;socket.close(1000,'dummy complete')};
socket.onerror=()=>{window.result.error=true};
socket.onclose=e=>{window.result.close=e.code};
</script>`;
await fs.writeFile(path.join(root, "index.html"), html);
const server = createServer((_request, response) => { response.setHeader("Content-Type","text/html"); response.end(html); });
const sockets = new WebSocketServer({server});
let connections = 0;
sockets.on("connection", () => { connections++; });
await new Promise<void>(resolve => server.listen(19090, "127.0.0.1", resolve));
const proxy = await staticProxy(root, 19091, 19090);
const chrome = await browser(9224);
const results: unknown[] = [];
try {
  for (const mode of ["request", "response", "real-http", "native-proxy"]) {
    const page = await chrome.page("about:blank", ["real-http", "native-proxy"].includes(mode) ? undefined : root, mode === "response");
    const errors: unknown[] = [];
    page.cdp.on("Network.webSocketFrameError", event => { errors.push(event); });
    page.cdp.on("Network.loadingFailed", event => { errors.push(event); });
    await page.cdp.call("Network.enable");
    await page.cdp.call("Page.navigate", {url:`http://127.0.0.1:${mode === "native-proxy" ? 19091 : 19090}/`});
    await delay(1500);
    results.push({mode, result:await page.cdp.evaluate("window.result"), connections, errors});
    await chrome.closePage(page);
  }
} finally {
  const closed = await chrome.close();
  const proxyClosed = await proxy.close();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close(); server.close();
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({results,closed,proxyClosed},null,2));
  console.log(JSON.stringify({results,closed,proxyClosed},null,2));
}
