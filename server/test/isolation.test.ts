import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MeasurementIsolation, processStart } from "../src/diagnostics/isolation.ts";

test("measurement isolation exists only while its exact collector owns a marker; removing it restores external admission", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nq-isolation-"));
  const file = path.join(root, "flag.json"), events: string[] = [];
  const gate = new MeasurementIsolation(file, e => { events.push(e); });
  try {
    assert.equal(gate.allows("https://preview.invalid"), true);
    await fs.writeFile(file, JSON.stringify({ ownerPid: process.pid, ownerStart: processStart(process.pid) }));
    assert.equal(gate.snapshot().enabled, true);
    assert.equal(gate.allows("http://127.0.0.1:19090"), true);
    assert.equal(gate.allows("https://preview.invalid"), false);
    assert.equal(gate.allows(), false);
    await fs.writeFile(file, JSON.stringify({ ownerPid: process.pid, ownerStart: "wrong-process-generation" }));
    assert.equal(gate.allows("https://preview.invalid"), true);
    await fs.writeFile(file, JSON.stringify({ ownerPid: process.pid, ownerStart: processStart(process.pid) }));
    assert.equal(gate.snapshot().enabled, true);
    await fs.unlink(file);
    assert.equal(gate.allows("https://preview.invalid"), true);
    assert.equal(events.at(-1), "measurement_isolation_released");
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});
