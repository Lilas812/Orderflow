import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const gone = e => ["ENOENT", "ESRCH"].includes(e?.code);
const dead = state => ["Z", "X", "x"].includes(state);
export function fault(reason, details = {}, cause) {
  return Object.assign(new Error(reason, cause ? { cause } : undefined), { reason, ...details });
}
/** Only explicitly selected diagnostic fields, never environ, cmdline or argv. */
export function faultRecord(error, phase, at = performance.now()) {
  const e = error instanceof Error ? error : fault(String(error));
  return { phase, timestamp: at, reason: e.reason ?? (e.code === "ERR_ASSERTION" ? e.message.split("\n")[0] : e.code ?? e.message),
    message: e.message, targetPid: e.targetPid ?? null, identity: e.identity ?? null,
    liveness: e.liveness ?? "UNKNOWN", resource: e.resource ?? { kind: "UNKNOWN", reason: e.reason ?? "OBSERVATION_FAILED" },
    reads: e.reads ?? [], readErrorCode: e.code ?? null, stack: e.stack ?? null, causeStack: e.cause?.stack ?? null };
}
function statFields(pid, text) {
  const end = text.lastIndexOf(")"), prefix = text.slice(0, text.indexOf(" ("));
  const f = text.slice(end + 2).trim().split(/\s+/);
  const p = { pid, ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]),
    state: f[0], startTicks: f[19], userTicks: Number(f[11]), systemTicks: Number(f[12]) };
  if (end < 0 || Number(prefix) !== pid || !Number.isSafeInteger(pid) || pid <= 0 ||
      !/^[RSDZTtXxKWPI]$/.test(p.state) || !/^\d+$/.test(p.startTicks ?? "") ||
      !["ppid", "pgid", "sid", "userTicks", "systemTicks"].every(k =>
        Number.isSafeInteger(p[k]) && p[k] >= 0))
    throw fault("PROCESS_STAT_INVALID", { targetPid: pid });
  return p;
}
export function parseIdentity(pid, stat, status) {
  const p = statFields(pid, stat), uid = status.match(/^Uid:[ \t]+(\d+)[ \t]+\d+[ \t]+\d+[ \t]+\d+[ \t]*$/m)?.[1];
  const statusPid = status.match(/^Pid:[ \t]+(\d+)[ \t]*$/m)?.[1];
  if (uid === undefined || !Number.isSafeInteger(Number(uid)) ||
      statusPid === undefined || Number(statusPid) !== pid)
    throw fault("PROCESS_STATUS_INVALID", { targetPid: pid });
  return { ...p, uid: Number(uid) };
}
export function sameIdentity(a, b) {
  return !!a && !!b && ["pid", "pgid", "sid", "uid", "startTicks"].every(k => a[k] === b[k]);
}
export function observeProcess(pid, { io = fs, phase = "RUNNING" } = {}) {
  const reads = [];
  const read = name => {
    try {
      const text = io.readFileSync(`/proc/${pid}/${name}`, "utf8");
      reads.push(name === "stat" ? { file: name, ...statFields(pid, text) } :
        { file: name, rssFieldPresent: /^VmRSS:/m.test(text) });
      return text;
    } catch (e) {
      reads.push({ file: name, error: e.code ?? e.reason ?? "READ_FAILED" });
      throw e;
    }
  };
  try {
    const first = read("stat"), status = read("status"), last = read("stat");
    const before = parseIdentity(pid, first, status), identity = parseIdentity(pid, last, status);
    if (!sameIdentity(before, identity))
      throw fault("PROCESS_IDENTITY_RACE", { identity });
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB\s*$/m);
    let resource;
    if (dead(identity.state)) resource = { kind: "NOT_APPLICABLE_EXITED" };
    else if (match && Number.isSafeInteger(Number(match[1]) * 1024))
      resource = { kind: "MEASURED", bytes: Number(match[1]) * 1024 };
    else resource = { kind: "UNKNOWN", reason: /^VmRSS:/m.test(status) ? "RSS_FIELD_INVALID" : "RSS_FIELD_MISSING" };
    return { identity, reads, liveness: dead(identity.state) ? "EXIT_CONFIRMED" :
      resource.kind === "UNKNOWN" && phase !== "RUNNING" ? "EXIT_TRANSITION" : "RUNNING", resource };
  } catch (e) {
    throw fault(e.reason ?? (gone(e) ? "PROCESS_DISAPPEARED" : "PROCESS_READ_FAILED"),
      { targetPid: pid, reads, code: e.code, identity: e.identity ?? null }, e);
  }
}
/** A complete identity-only inventory can be used for cleanup even without RSS. */
export function readGroup(pgid, { io = fs, phase = "RUNNING", known = [] } = {}) {
  const processes = [], observations = [], departures = [];
  for (const name of io.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let candidate;
    try { candidate = statFields(pid, io.readFileSync(`/proc/${pid}/stat`, "utf8")); }
    catch (e) { if (gone(e)) continue; throw fault("GROUP_ENUMERATION_FAILED", { targetPid: pid, code: e.code }, e); }
    const prior = known.find(p => p.pid === pid);
    if (prior && (candidate.startTicks !== prior.startTicks || candidate.pgid !== prior.pgid || candidate.sid !== prior.sid))
      throw fault("KNOWN_PROCESS_IDENTITY_CHANGED", { targetPid: pid, identity: candidate });
    if (candidate.pgid !== pgid && candidate.sid !== pgid) continue;
    try {
      const observation = observeProcess(pid, { io, phase }), p = observation.identity;
      if (p.startTicks !== candidate.startTicks || p.pgid !== candidate.pgid || p.sid !== candidate.sid)
        throw fault("PROCESS_IDENTITY_RACE", { targetPid: pid, identity: p });
      observations.push(observation);
      processes.push({ ...p, rss: observation.resource.kind === "MEASURED" ? observation.resource.bytes : null });
    } catch (e) {
      if (gone(e)) departures.push(faultRecord(e, phase));
      else throw e;
    }
  }
  return { processes, observations, departures,
    live: processes.filter(p => p.pgid === pgid && !dead(p.state)).map(p => p.pid),
    zombies: processes.filter(p => dead(p.state)).map(p => p.pid) };
}
export function checkOwnership(started, snapshot, known = [], childExited = false) {
  assert(started && started.pid === started.pgid && started.pid === started.sid, "OWNERSHIP_UNKNOWN");
  const ids = new Map(snapshot.processes.map(p => [p.pid, p]));
  assert(ids.size === snapshot.processes.length, "OWNERSHIP_DUPLICATE_PID");
  for (const p of snapshot.processes) {
    assert(p.pgid === started.pgid && p.sid === started.sid && p.uid === started.uid, "OWNERSHIP_MISMATCH");
    const prior = known.find(k => k.pid === p.pid) ?? (p.pid === started.pid ? started : null);
    assert(!prior || sameIdentity(prior, p), "PID_REUSED");
    if (!childExited) {
      let current = p; const seen = new Set();
      for (;;) {
        assert(current && !seen.has(current.pid) && current.uid === started.uid &&
          current.sid === started.sid && BigInt(current.startTicks) >= BigInt(started.startTicks),
        "OWNERSHIP_ANCESTRY");
        seen.add(current.pid);
        if (current.pid === started.pid) {
          assert(sameIdentity(started, current), "PID_REUSED");
          assert(current.ppid === started.ppid, "LEADER_PARENT_CHANGED"); break;
        }
        const parent = ids.get(current.ppid);
        assert(parent && BigInt(parent.startTicks) <= BigInt(current.startTicks), "OWNERSHIP_ANCESTRY");
        current = parent;
      }
    } else assert(prior && sameIdentity(prior, p), "EXITING_PROCESS_UNKNOWN");
  }
  if (!childExited) assert(ids.has(started.pid), "LEADER_NOT_VERIFIABLE");
  return { status: snapshot.processes.length ? "OWNED" : childExited ? "EMPTY" : "UNKNOWN" };
}
export function resourceSample(snapshot, limits, phase, at) {
  assert(snapshot.processes.length <= limits.processes, "PROCESS_CAP");
  assert(!snapshot.departures.length || phase !== "RUNNING", "PROCESS_READ_RACE");
  const unknown = snapshot.observations.filter(o => o.resource.kind === "UNKNOWN");
  if (phase === "RUNNING" && unknown.length)
    throw fault("RUNNING_RSS_UNKNOWN", { targetPid: unknown[0].identity.pid,
      identity: unknown[0].identity, reads: unknown[0].reads, liveness: "RUNNING", resource: unknown[0].resource });
  const measured = snapshot.observations.filter(o => o.resource.kind === "MEASURED");
  const measuredBytes = measured.reduce((sum, o) => sum + o.resource.bytes, 0);
  assert(measuredBytes <= limits.rss, "RSS_CAP");
  return { at, resource: unknown.length || snapshot.departures.length ?
    { kind: "UNKNOWN", reason: "EXIT_RESOURCE_PENDING", measuredBytes } :
    measured.length ? { kind: "MEASURED", bytes: measuredBytes } : { kind: "NOT_APPLICABLE_EXITED" },
  processes: snapshot.processes.length,
  states: snapshot.observations.map(o => ({ pid: o.identity.pid, liveness: o.liveness, resource: o.resource })),
  anomalies: unknown, departures: snapshot.departures,
  cpu: snapshot.processes.map(p => ({ pid: p.pid, startTicks: p.startTicks, ticks: p.userTicks + p.systemTicks })) };
}
/** Register all barriers synchronously; exit is not stdio close. */
export function captureChild(child, now = () => performance.now()) {
  const state = { spawned: false, error: null, exit: null, close: null, events: [] };
  let spawnResolve, spawnReject, exitResolve, closeResolve;
  const spawned = new Promise((resolve, reject) => { spawnResolve = resolve; spawnReject = reject; });
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const closed = new Promise(resolve => { closeResolve = resolve; });
  // The rejection can precede the caller's first await.
  spawned.catch(() => {});
  const event = (kind, value) => state.events.push({ kind, at: now(), ...value });
  child.once("spawn", () => { state.spawned = true; event("spawn"); spawnResolve(); });
  child.on("error", e => {
    state.error ??= faultRecord(e, "CHILD_ERROR", now()); event("child-error", { reason: e.code ?? e.message });
    if (!state.spawned) spawnReject(e);
  });
  child.once("exit", (code, signal) => {
    state.exit = { code, signal, at: now() }; event("exit", state.exit); exitResolve(state.exit);
  });
  child.once("close", (code, signal) => {
    state.close = { code, signal, at: now() }; event("close", state.close); closeResolve(state.close);
  });
  return { state, spawned, exited, closed };
}
export async function bounded(promise, ms, reason, clock = globalThis) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = clock.setTimeout(() => reject(fault(reason)), Math.max(0, ms));
    })]);
  } finally { clock.clearTimeout(timer); }
}
export function profileReceipt(profile, runId, io = fs) {
  const s = io.lstatSync(profile), canonical = io.realpathSync(profile);
  assert(s.isDirectory() && !s.isSymbolicLink() && canonical === path.resolve(profile) &&
    s.uid === process.getuid() && (s.mode & 0o777) === 0o700, "PROFILE_OWNER");
  return { path: canonical, uid: s.uid, device: s.dev, inode: s.ino, mode: s.mode & 0o777, runId };
}
export function reclaimProfile(receipt, runId, owner, snapshot, barriers, io = fs) {
  assert(barriers.exit && barriers.close && owner && receipt.runId === runId &&
    owner.pid === owner.pgid && owner.pid === owner.sid && owner.uid === receipt.uid &&
    snapshot.processes.length === 0 && !snapshot.departures.length, "PROFILE_EXIT_OR_OWNER");
  const current = profileReceipt(receipt.path, runId, io);
  assert(["path", "uid", "device", "inode", "mode", "runId"].every(k => current[k] === receipt[k]), "PROFILE_IDENTITY");
  io.rmSync(receipt.path, { recursive: true });
  assert(!io.existsSync(receipt.path), "PROFILE_REMAINING");
  return { removed: true, remaining: 0 };
}
/** Each shutdown step runs once; failures remain failures, later evidence steps still run. */
export function createShutdown(steps, onFault = () => {}) {
  let pending;
  return () => pending ??= Promise.resolve().then(async () => {
    const results = [];
    for (const [phase, run] of steps) {
      try { results.push({ phase, status: "PASS", value: await run() }); }
      catch (e) {
        const record = faultRecord(e, phase); results.push({ phase, status: "FAIL", fault: record });
        onFault(record);
      }
    }
    return results;
  });
}
