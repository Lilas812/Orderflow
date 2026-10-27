// Injected only by the benchmark's CDP session, never imported by the app.
// Replay of real saved bytes. Empty/missing seconds stay empty/missing.
(() => {
  const NativeSocket = window.WebSocket;
  const prefix = "/@fs/home/runner/workspace/data/perf-memory/render-fixture/";
  const fixture = Promise.all([
    fetch(prefix + "metadata.json").then(r => r.json()),
    fetch(prefix + "columns.bin").then(r => r.arrayBuffer()),
    fetch(prefix + "trades.json").then(r => r.json()),
  ]).then(([metadata, bytes, trades]) => {
    const view = new DataView(bytes), columns = [];
    for (let at = 0; at < bytes.byteLength;) {
      const size = 9 + 8 * (view.getUint16(at + 5, true) + view.getUint16(at + 7, true));
      columns.push({ sec: view.getUint32(at, true), bytes: new Uint8Array(bytes, at, size) });
      at += size;
    }
    return { metadata, columns, trades };
  });
  window.WebSocket = class FrozenSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; extensions = "frozen-saved-fixture"; binaryType = "arraybuffer";
    onopen = null; onmessage = null; onclose = null; onerror = null;
    jobs = Promise.resolve();
    constructor(url, protocols) {
      super();
      if (!String(url).includes("/api/ws")) return new NativeSocket(url, protocols);
      fixture.then(async data => {
        this.data = data; this.readyState = 1; this.onopen?.(new Event("open"));
        this.emit({ type: "hello", symbol: "NQ", tickSize: 0.25, columnSeconds: 1,
          mode: "replay", serverTimeUs: data.metadata.toSec * 1e6,
          savedRange: { fromSec: data.metadata.fromSec, toSec: data.metadata.toSec } });
        await this.range(0, data.metadata.toSec - 1800, data.metadata.toSec);
        const last = data.columns.at(-1);
        if (last) this.frame(3, 0, [last]);
        window.__frozenFeedReady = true;
      }).catch(error => { window.__frozenFeedError = String(error); this.onerror?.(new Event("error")); });
    }
    emit(value) {
      const data = value instanceof ArrayBuffer ? value : JSON.stringify(value);
      this.onmessage?.(new MessageEvent("message", { data }));
    }
    frame(kind, reqId, columns) {
      const result = new Uint8Array(9 + columns.reduce((sum, c) => sum + c.bytes.length, 0));
      const head = new DataView(result.buffer);
      head.setUint8(0, kind); head.setUint32(1, reqId, true); head.setUint32(5, columns.length, true);
      let at = 9;
      for (const c of columns) { result.set(c.bytes, at); at += c.bytes.length; }
      this.emit(result.buffer);
    }
    async range(reqId, fromSec, toSec) {
      let columnCount = 0, tradeCount = 0, chunks = 0;
      for (let start = fromSec; start < toSec; start += 300) {
        const end = Math.min(toSec, start + 300);
        const columns = this.data.columns.filter(c => c.sec >= start && c.sec < end);
        const trades = this.data.trades.filter(t => t.tsUs >= start * 1e6 && t.tsUs < end * 1e6);
        this.frame(2, reqId, columns);
        this.emit({ type: "rangeTrades", reqId, trades });
        columnCount += columns.length; tradeCount += trades.length; chunks++;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      this.emit({ type: "rangeDone", reqId, fromSec, toSec, columns: columnCount, trades: tradeCount, chunks });
    }
    send(text) {
      const request = JSON.parse(text);
      if (request.op === "range") this.jobs = this.jobs.then(() => this.range(request.reqId, request.fromSec, request.toSec));
    }
    close(code = 1000, reason = "") {
      this.readyState = 3; this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
    }
  };
})();
