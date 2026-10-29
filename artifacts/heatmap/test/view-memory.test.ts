import test from "node:test";
import assert from "node:assert/strict";
import { loadView, saveView } from "../src/view-memory.ts";

const tab = () => {
  const data = new Map<string, string>();
  return { data, sessionStorage: { getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); } } };
};
function inTab(t: ReturnType<typeof tab>, run: () => void) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: t });
  try { run(); }
  finally { if (old) Object.defineProperty(globalThis, "window", old); else Reflect.deleteProperty(globalThis, "window"); }
}
test("view memory：画面・NQ/GC別、同じsessionを使うreload相当で維持", () => {
  const a = tab();
  inTab(a, () => {
    saveView("footprint", "NQ", { endSec: 50, barW: 92, follow: false });
    saveView("footprint", "GC", { endSec: 60, barW: 40, follow: true });
    saveView("heatmap", "NQ", { endSec: 70 });
    saveView("longvp", "NQ", { endSec: 80 });
  });
  inTab(a, () => {
    assert.deepEqual(loadView("footprint", "NQ"), { endSec: 50, barW: 92, follow: false });
    assert.deepEqual(loadView("footprint", "GC"), { endSec: 60, barW: 40, follow: true });
    assert.deepEqual(loadView("heatmap", "NQ"), { endSec: 70 });
    assert.deepEqual(loadView("longvp", "NQ"), { endSec: 80 });
  });
});
test("view memory：別sessionの変更を混ぜず、元sessionを維持", () => {
  const a = tab(), b = tab();
  inTab(a, () => saveView("footprint", "GC", { endSec: 10 }));
  inTab(b, () => {
    assert.equal(loadView("footprint", "GC"), null);
    saveView("footprint", "GC", { endSec: 20 });
  });
  inTab(a, () => assert.deepEqual(loadView("footprint", "GC"), { endSec: 10 }));
});
test("view memory：不正JSON・保存不可で画面を落とさない", () => {
  const a = tab(); a.data.set("view.footprint.NQ", "{broken");
  inTab(a, () => {
    assert.equal(loadView("footprint", "NQ"), null);
    a.sessionStorage.setItem = () => { throw Error("blocked"); };
    assert.doesNotThrow(() => saveView("footprint", "NQ", {}));
  });
});
