import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { definition } from "../load29/generator";
const driverModule = "./runner.mjs", processModule = "./process.mjs";
const { verifyInput, publicMatch, decodeBlock, glGate } = await import(driverModule);
const { parseArguments, validateOutputPath, createOutput, recordFailure, pins, writeAggregate } = await import(driverModule);
const { parseProcess, resourceGate } = await import(processModule);
const { ownershipEvidence, cleanupOwnership, createMonitorLifecycle } = await import(processModule);
const { aggregateExitCode } = await import(driverModule);
import { BUDGET } from "./contracts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { canonical } from "./contracts";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
describe("driver gates (artificial data only)", () => {
  it("checks input SHA, not a setting pretending to be a receipt", () => {
    const d = definition(0);
    expect(() => verifyInput(d, 0, d.inputSha256)).not.toThrow();
    expect(() => verifyInput(d, 0, "0".repeat(64))).toThrow("SHA");
  });
  it("rejects event order changes", () => {
    const d = structuredClone(definition(0)); const a = [...d.inputs]; [a[0], a[1]] = [a[1], a[0]];
    expect(() => verifyInput({ ...d, inputs: a }, 0, d.inputSha256)).toThrow("SHA");
  });
  it("rejects meaning mismatch", () => {
    expect(() => publicMatch({ revision: 1 }, digest('{"revision":2}'))).toThrow("MISMATCH");
  });
  it("validates lossless compressed block SHA", () => {
    const raw = '[{"kind":"frame","revision":9}]';
    const b = { codec: "gzip/base64", bytes: Buffer.byteLength(raw), data: gzipSync(raw).toString("base64"), sha256: digest(raw) };
    expect(decodeBlock(b)).toEqual([{ kind: "frame", revision: 9 }]);
    expect(() => decodeBlock({ ...b, sha256: "bad" })).toThrow("BLOCK_SHA");
    expect(() => decodeBlock({ ...b, bytes: 1 })).toThrow("BLOCK_BYTES");
  });
  for (const error of ["GL_ERROR", "OBSERVER_LIMIT"]) it(`never hides actual ${error}`, () => {
    expect(() => glGate({ fault: error, totals: { errors: 0, loss: 0 } })).toThrow();
  });
  it("detects GL errors even if the fault field is empty", () => {
    expect(() => glGate({ fault: null, totals: { errors: 1, loss: 0 } })).toThrow();
  });
  const p = { pid: 9999, ppid: 10, pgid: 9999, sid: 9999, startTicks: "1000", uid: 1000, state: "S",
    rss: 100, userTicks: 1, systemTicks: 1 };
  it("records measurable owned resources", () => {
    expect(resourceGate(p, { processes: [p], live: [p.pid] }, p, BUDGET).rss).toBe(100);
  });
  it("rejects memory excess", () => {
    expect(() => resourceGate(p, { processes: [{ ...p, rss: BUDGET.browserRss + 1 }], live: [p.pid] }, p, BUDGET)).toThrow("RSS_CAP");
  });
  it("protects reused and unknown owners", () => {
    expect(() => resourceGate(p, { processes: [{ ...p, startTicks: "999" }], live: [p.pid] }, p, BUDGET)).toThrow("OWNERSHIP");
  });
  it("refuses unknown running RSS rather than recording zero", () => {
    expect(() => resourceGate(p, { processes: [{ ...p, rss: null }], live: [p.pid] }, p, BUDGET)).toThrow("RSS_UNKNOWN");
  });
  it("distinguishes known-exited RSS from unknown running RSS", () => {
    const fields = (state: string) => `99 (node) ${[state, "1", "99", "99", ...Array(15).fill("0"), "1000"].join(" ")}`;
    expect(parseProcess(99, fields("Z"), "Uid: 1000\n").rss).toBeNull();
    expect(() => parseProcess(99, fields("S"), "Uid: 1000\n")).toThrow("RUNNING_RSS_UNKNOWN");
  });
  it("persists and losslessly reloads actual public frame checkpoints in a private temporary directory", async () => {
    const { journal } = await import(driverModule);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "load29-offline-"));
    try {
      const d = definition(0), hub = createAnalysisHub(d.scope, () => 0);
      d.inputs.forEach(i => expect(hub.ingest(i).disposition).toBe("ACCEPTED"));
      const text = canonical(hub.readRenderFrame(d.query));
      const j = journal(0, directory); j.append({ kind: "frame", prefix: 128, canonical: text });
      const receipt = j.checkpoint();
      const rows = decodeBlock(JSON.parse(fs.readFileSync(path.join(directory, receipt.blocks[0].file), "utf8")));
      expect(rows[0].canonical).toBe(text);
      expect(() => publicMatch(JSON.parse(rows[0].canonical), digest(text))).not.toThrow();
      expect(() => j.append({ huge: "x".repeat(BUDGET.wireBytes + 1) })).toThrow("ROW_CAP");
    } finally { fs.rmSync(directory, { recursive: true }); }
  });
});
describe("ownership transitions and CLI automation (no OS signals)", () => {
  const leader = { pid: 100, ppid: 10, pgid: 100, sid: 100, startTicks: 20, uid: 1000, state: "R" };
  const child = { ...leader, pid: 101, ppid: 100, startTicks: 21 };
  const snap = (processes: any[]) => ({ processes, live: processes.map(p => p.pid), zombies: [] });
  it("records verified running ownership and the actual conditions", () => {
    const r = ownershipEvidence(leader, snap([leader, child]), "RUNNING", 42, { heldLeader: true });
    expect(r.status).toBe("PASS"); expect(r.observed.processes.length).toBe(2);
    expect(r.child.heldLeader).toBe(true); expect(r.at).toBe(42);
  });
  it("retains reason, phase, expected identity and snapshot on PID reuse", () => {
    const s = snap([{ ...leader, startTicks: 999 }]);
    const r = ownershipEvidence(leader, s, "RUNNING", 43);
    expect(r.code).toBe("OWNERSHIP_UNKNOWN"); expect(r.reason).toBe("PID_OR_PGID_REUSED");
    expect(r.targetPid).toBe(100); expect(r.expected).toEqual(leader); expect(r.observed).toEqual(s);
  });
  it("does not waive unknown or reused processes during cleanup", () => {
    const unknown = { ...child, pid: 102, ppid: 1 };
    expect(cleanupOwnership(leader, snap([unknown]), [leader, child], true).status).toBe("FAIL");
    expect(cleanupOwnership(leader, snap([{ ...child, startTicks: 99 }]), [leader, child], true).status).toBe("FAIL");
  });
  it("distinguishes known exiting descendants from an empty, confirmed exit", () => {
    expect(cleanupOwnership(leader, snap([child]), [leader, child], true).status).toBe("EXITING");
    expect(cleanupOwnership(leader, snap([]), [leader, child], true).status).toBe("EMPTY");
    expect(cleanupOwnership(leader, snap([]), [leader, child], false).status).toBe("FAIL");
  });
  it("stops RUNNING sampling before close and does not resume it", () => {
    let t = 1; const life = createMonitorLifecycle(() => t++);
    expect(life.phase).toBe("RUNNING"); life.beginCleanup(); life.beginCleanup();
    expect(life.phase).toBe("CLEANUP");
    expect(life.events.map((e: any) => e.kind)).toEqual(["monitor-start", "monitor-stop"]);
    life.closed(); expect(life.phase).toBe("CLOSED");
  });
  it("returns zero only for all three successful stages", () => {
    const good = { status: "PASS", stages: [0, 1, 2].map(stage => ({ stage, status: "PASS" })) };
    expect(aggregateExitCode(good)).toBe(0);
    expect(aggregateExitCode({ ...good, stages: good.stages.slice(0, 1) })).toBe(1);
    for (const status of ["FAIL", "HOLD"]) expect(aggregateExitCode({ ...good, status })).toBe(1);
  });
  it("keeps cleanup, original, and save failures nonzero without exiting early", () => {
    const stages = [0, 1, 2].map(stage => ({ stage, status: "PASS" }));
    expect(aggregateExitCode({ status: "PASS", stages: stages.map((s, i) => i ? s : { ...s, cleanup: { status: "FAIL" } }) })).toBe(1);
    expect(aggregateExitCode({ status: "PASS", stages: stages.map((s, i) => i ? s : { ...s, error: "ORIGINAL_FAIL" }) })).toBe(1);
    expect(aggregateExitCode({ status: "FAIL", error: "SAVE_FAILED", originalResult: { error: "DRAW_FAILED" } })).toBe(1);
    const source = fs.readFileSync(new URL("./runner.mjs", import.meta.url), "utf8");
    expect(source).toContain("process.exitCode = aggregateExitCode(aggregate)");
    expect(source).not.toContain("process.exit(");
  });
});

describe("explicit output isolation (no browser)", () => {
  function sandbox(run: (s: { workspace: string; base: string; target: string }) => void) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "load29-output-test-"));
    const base = path.join(workspace, ".local/diagnostics");
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    try { run({ workspace, base, target: path.join(base, "task29-b-r2") }); }
    finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  }
  it("requires exactly one explicit output option", () => {
    expect(parseArguments(["--run", "--output-dir", ".local/diagnostics/task29-b-r2"])).toEqual({
      outputDir: ".local/diagnostics/task29-b-r2", dryRun: false,
    });
    expect(() => parseArguments(["--run"])).toThrow("OUTPUT_DIR_REQUIRED");
    expect(() => parseArguments(["--run", "--output-dir"])).toThrow("OUTPUT_ARGUMENT");
    expect(() => parseArguments(["--run", "--output-dir", "a", "--output-dir", "b"])).toThrow("OUTPUT_ARGUMENT");
    expect(() => parseArguments(["--run", "--unknown"])).toThrow("UNKNOWN_ARGUMENT");
  });
  it("supports a non-writing dry-run without changing the target", () => sandbox(({ workspace, target }) => {
    expect(parseArguments(["--run", "--output-dir", target, "--dry-run"]).dryRun).toBe(true);
    expect(validateOutputPath(target, workspace)).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
  }));
  it("accepts normalized absolute and relative paths within the permitted area", () => sandbox(({ workspace, target }) => {
    expect(validateOutputPath(".local/diagnostics/task29-b-r2/", workspace)).toBe(target);
    expect(validateOutputPath(target, workspace)).toBe(target);
  }));
  it("creates an exclusively owned 0700 output directory", () => sandbox(({ workspace, target }) => {
    const output = createOutput(target, workspace);
    expect(output.directory).toBe(target);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(target)).toEqual([]);
    output.write("preflight.json", { status: "PASS" });
    expect(output.read("preflight.json")).toEqual({ status: "PASS" });
  }));
  for (const name of ["task29-a", "task29-b", "task29-b-r1", "task28-c5-r1", "task28-e2", "task28-r3"]) {
    it(`refuses the protected reference name ${name}`, () => sandbox(({ workspace, base }) => {
      expect(() => createOutput(path.join(base, name), workspace)).toThrow("PROTECTED_REFERENCE");
      expect(fs.readdirSync(base)).toEqual([]);
    }));
  }
  it("rejects traversal even when it would normalize back inside the base", () => sandbox(({ workspace }) => {
    expect(() => createOutput(".local/diagnostics/../diagnostics/task29-b-r2", workspace)).toThrow("TRAVERSAL");
  }));
  it("rejects normalized paths outside diagnostics and nested paths", () => sandbox(({ workspace, base }) => {
    expect(() => createOutput(path.join(workspace, "task29-b-r2"), workspace)).toThrow("OUTSIDE");
    expect(() => createOutput(path.join(base, "nested/task29-b-r2"), workspace)).toThrow("OUTSIDE");
  }));
  it("rejects an output symlink without touching its protected target", () => sandbox(({ workspace, base, target }) => {
    const prior = path.join(base, "task29-b"); fs.mkdirSync(prior);
    fs.writeFileSync(path.join(prior, "sentinel"), "unchanged");
    fs.symlinkSync(prior, target);
    expect(() => createOutput(target, workspace)).toThrow();
    expect(fs.readFileSync(path.join(prior, "sentinel"), "utf8")).toBe("unchanged");
  }));
  it("rejects a symlink in a parent directory", () => sandbox(({ workspace, base, target }) => {
    const moved = path.join(workspace, "moved");
    fs.renameSync(base, moved); fs.symlinkSync(moved, base);
    expect(() => createOutput(target, workspace)).toThrow("SYMLINK");
    expect(fs.readdirSync(moved)).toEqual([]);
  }));
  it("rejects a file in place of the output directory", () => sandbox(({ workspace, target }) => {
    fs.writeFileSync(target, "original");
    expect(() => createOutput(target, workspace)).toThrow("ALREADY_EXISTS");
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  }));
  it("rejects an existing nonempty directory", () => sandbox(({ workspace, target }) => {
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, "old.json"), "{}");
    expect(() => createOutput(target, workspace)).toThrow("ALREADY_EXISTS");
  }));
  it("refuses a second start, including an existing empty claim", () => sandbox(({ workspace, target }) => {
    createOutput(target, workspace);
    expect(() => createOutput(target, workspace)).toThrow("ALREADY_EXISTS");
  }));
  for (const name of ["preflight.json", "stage0-checkpoint.json", "stage1-result.json",
    "stage2-cleanup.json", "stage0-input.json"]) {
    it(`publishes ${name} only to the claimed new directory`, () => sandbox(({ workspace, target, base }) => {
      const reference = path.join(base, "task29-b"); fs.mkdirSync(reference);
      fs.writeFileSync(path.join(reference, "preflight.json"), '{"readonly":true}');
      const output = createOutput(target, workspace);
      const receipt = output.write(name, { status: "PASS", marker: name });
      expect(digest(fs.readFileSync(path.join(target, receipt.file), "utf8"))).toBe(receipt.sha256);
      expect(output.read(name).marker).toBe(name);
      expect(fs.readdirSync(reference)).toEqual(["preflight.json"]);
      expect(fs.readFileSync(path.join(reference, "preflight.json"), "utf8")).toBe('{"readonly":true}');
    }));
  }
  it("routes block publication and lossless reads through the output writer", async () => {
    const { journal } = await import(driverModule);
    sandbox(({ workspace, target }) => {
      const output = createOutput(target, workspace), j = journal(0, output);
      j.append({ kind: "probe", prefix: 2 }); const checkpoint = j.checkpoint();
      expect(decodeBlock(output.read(checkpoint.blocks[0].file))).toEqual([{ kind: "probe", prefix: 2 }]);
      expect(() => journal(0)).toThrow("OUTPUT_DIR_REQUIRED");
    });
  });
  it("routes aggregate, report and digest manifest to the new directory", () => sandbox(({ workspace, target }) => {
    const output = createOutput(target, workspace);
    writeAggregate(output, { status: "FAIL", stages: [{ stage: 0, status: "FAIL" }] });
    expect(output.read("aggregate.json").status).toBe("FAIL");
    expect(output.read("report.json").status).toBe("FAIL");
    const manifest = output.read("evidence-sha256.json");
    expect(manifest.files.map((f: { file: string }) => f.file)).toEqual(["aggregate.json", "report.json"]);
    for (const f of manifest.files) expect(digest(fs.readFileSync(path.join(target, f.file), "utf8"))).toBe(f.sha256);
  }));
  it("retains partial failure evidence and never relabels it PASS", () => sandbox(({ workspace, target }) => {
    const output = createOutput(target, workspace);
    const failure = recordFailure(output, Error("ACTUAL_DRAW_FAILURE"));
    expect(failure.status).toBe("FAIL");
    expect(output.read("run-error.json").error).toContain("ACTUAL_DRAW_FAILURE");
  }));
  it("preserves the original error if saving the failure itself fails", () => {
    const result = recordFailure({ write() { throw Error("DISK_FAILURE"); } }, Error("ORIGINAL_FAILURE"));
    expect(result.status).toBe("FAIL");
    expect(result.error).toContain("ORIGINAL_FAILURE");
    expect(result.evidenceError).toContain("DISK_FAILURE");
  });
  it("preserves a failed checkpoint and the evidence publication error independently", () => sandbox(({ workspace, target }) => {
    const output = createOutput(target, workspace);
    output.write("stage0-checkpoint.json", { status: "FAIL", error: "ORIGINAL_DRAW_FAILURE" });
    let caught;
    try { output.write("stage0-checkpoint.json", { status: "FAIL", error: "ORIGINAL_DRAW_FAILURE" }); }
    catch (error) { caught = error; }
    const failure = recordFailure(output, caught);
    expect(failure.status).toBe("FAIL");
    expect(failure.error).toBe("ORIGINAL_DRAW_FAILURE");
    expect(failure.saveError).toContain("OUTPUT_EEXIST");
    expect(output.read("stage0-checkpoint.json").error).toBe("ORIGINAL_DRAW_FAILURE");
  }));
  it("does not overwrite a previous checkpoint or delete unexpected output files", () => sandbox(({ workspace, target }) => {
    const output = createOutput(target, workspace);
    output.write("stage0-checkpoint.json", { value: 1 });
    expect(() => output.write("stage0-checkpoint.json", { value: 2 })).toThrow("EEXIST");
    expect(output.read("stage0-checkpoint.json").value).toBe(1);
    expect(fs.readdirSync(target)).toEqual(["stage0-checkpoint.json"]);
  }));
  it("rejects read/write traversal names and a swapped output directory", () => sandbox(({ workspace, target }) => {
    const output = createOutput(target, workspace);
    expect(() => output.write("../old.json", {})).toThrow("FILENAME");
    expect(() => output.read("../old.json")).toThrow("FILENAME");
    fs.renameSync(target, target + "-original"); fs.mkdirSync(target, { mode: 0o700 });
    expect(() => output.write("checkpoint.json", {})).toThrow("IDENTITY");
  }));
  it("reads a reference preflight without creating or changing any reference file", () => sandbox(({ base }) => {
    const source = path.join(base, "source.json"), preflight = path.join(base, "reference.json");
    fs.writeFileSync(source, '{"original":1}');
    fs.writeFileSync(preflight, JSON.stringify({ sources: [{ path: source, sha256: digest('{"original":1}') }], evidence: [] }));
    const before = fs.readFileSync(preflight, "utf8");
    expect(pins(preflight).sources.length).toBe(1);
    expect(fs.readFileSync(preflight, "utf8")).toBe(before);
    expect(fs.readdirSync(base).sort()).toEqual(["reference.json", "source.json"]);
  }));
  it("leaves the frozen stage inputs and execution budgets unchanged", () => {
    expect(([0, 1, 2] as const).map(s => definition(s).inputs.length)).toEqual([128, 256, 500]);
    expect(BUDGET.wallMs).toEqual([70000, 120000, 210000]);
    expect(BUDGET.totalWallMs).toBe(420000);
    expect(BUDGET.processes).toBe(24);
    expect(BUDGET.browserRss).toBe(2 * 1024 ** 3);
    expect(BUDGET.wireBytes).toBe(8 * 1024 ** 2);
    const source = fs.readFileSync(new URL("./runner.mjs", import.meta.url), "utf8");
    expect(source).toContain('detached: true');
    expect(source).toContain('createBrowserTermination({');
    expect(source).toContain('const cleanup = await termination.finish()');
    expect(source).not.toContain('save(ROOT,');
  });
  it("accepts each literal stage and rejects mismatched stage input counts", () => {
    for (const stage of [0, 1, 2] as const) {
      const input = definition(stage);
      expect(() => verifyInput(input, stage, input.inputSha256)).not.toThrow();
      expect(() => verifyInput(input, stage === 0 ? 1 : 0, input.inputSha256))
        .toThrow("STAGE_INPUT_COUNT");
    }
  });
});
