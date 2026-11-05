"""Read-only purchased-trade adapter; private, content-addressed range-bar output."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
PRIVATE = ROOT / "data/research-range-bars"
VERSION = "range-raw-v2"
CT = ZoneInfo("America/Chicago")
FROM_US = int(datetime(2026, 9, 29, 17, tzinfo=CT).timestamp() * 1_000_000)
TO_US = int(datetime(2026, 10, 30, 17, tzinfo=CT).timestamp() * 1_000_000)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def session(us):
    d = datetime.fromtimestamp(us / 1_000_000, CT)
    start = d.replace(hour=17, minute=0, second=0, microsecond=0)
    if d < start:
        start -= timedelta(days=1)
    end = start + timedelta(days=1)
    return (end.date().isoformat(), start.date().isoformat(),
            int(start.timestamp() * 1_000_000), int(end.timestamp() * 1_000_000))


def scheduled(us):
    d = datetime.fromtimestamp(us / 1_000_000, CT)
    return d.hour == 16 or d.weekday() == 5 or (d.weekday() == 4 and d.hour >= 16) or (d.weekday() == 6 and d.hour < 17)


def missing_intervals(coverage, start, end):
    cursor = start
    out = []
    for a, b in coverage:
        a, b = max(start, a), min(end, b)
        if b <= a:
            continue
        if a > cursor:
            out.extend(classify_gap(cursor, a))
        cursor = max(cursor, b)
    if cursor < end:
        out.extend(classify_gap(cursor, end))
    return out


def classify_gap(a, b):
    out = []
    while a < b:
        end = min(b, (a // 3_600_000_000 + 1) * 3_600_000_000)
        kind = "scheduled" if scheduled(a) else "missing"
        if out and out[-1]["kind"] == kind:
            out[-1]["toUs"] = end
        else:
            out.append({"fromUs": a, "toUs": end, "kind": kind, "at": 0})
        a = end
    return out


def integer(value, name, minimum=None):
    if type(value) is not int or abs(value) > 9_007_199_254_740_991 or (minimum is not None and value < minimum):
        raise ValueError(f"invalid integer {name}")
    return value


class Builder:
    def __init__(self, width, reversal_ticks, coverage):
        integer(width, "width", 1)
        integer(reversal_ticks, "reversalTicks", 1)
        self.width, self.reversal = width, reversal_ticks
        self.coverage = coverage
        self.ci = 0
        self.bars, self.candidates = [], []
        self.bar = None
        self.boundary = None
        self.segment = -1
        self.low = self.high = None
        self.direction = 0
        self.totals = dict(count=0, buy=0, sell=0, unknown=0)
        self.previous = None

    def close(self, reason):
        if self.bar:
            self.bar["partial"] = reason != "width"
            self.bar["reason"] = reason
            self.bars.append(self.bar)
            self.bar = None

    def finish_candidate(self):
        ref = self.high if self.direction >= 0 else self.low
        if ref:
            self.candidates.append(dict(kind="top" if self.direction >= 0 else "bottom",
                                        ref=ref, confirmedUs=None, segment=self.segment))
        self.low = self.high = None
        self.direction = 0

    def add(self, t, ref):
        ts, seq, price, size = (integer(t[k], k, 0 if k != "size" else 1) for k in ("tsUs", "seq", "price", "size"))
        side = t["side"]
        if side not in ("buy", "sell", "unknown"):
            raise ValueError("invalid side")
        if self.previous and (ts, seq) < self.previous:
            raise ValueError("adapter order regression")
        self.previous = ts, seq
        while self.ci < len(self.coverage) and self.coverage[self.ci][1] <= ts:
            self.ci += 1
        if self.ci == len(self.coverage) or not self.coverage[self.ci][0] <= ts < self.coverage[self.ci][1]:
            raise ValueError(f"trade outside certified tick coverage: {ts}")
        label, _, start, _ = session(ts)
        boundary = (start, self.ci)
        if boundary != self.boundary:
            self.close("coverage" if self.boundary and start == self.boundary[0] else "session")
            self.finish_candidate()
            self.boundary = boundary
            self.segment += 1
        self.totals["count"] += 1
        self.totals[side] += size
        if self.bar is None:
            self.bar = dict(startUs=ts, endUs=ts, open=price, high=price, low=price, close=price,
                            startSeq=seq, endSeq=seq, startLine=ref["line"], endLine=ref["line"],
                            buy=0, sell=0, unknown=0, count=0, highRef=ref, lowRef=ref,
                            session=label, partial=False, reason="", segment=self.segment)
        b = self.bar
        b["endUs"], b["close"] = ts, price
        b["endSeq"], b["endLine"] = seq, ref["line"]
        b[side] += size
        b["count"] += 1
        if price > b["high"]:
            b["high"], b["highRef"] = price, ref
        if price < b["low"]:
            b["low"], b["lowRef"] = price, ref
        if b["high"] - b["low"] >= self.width:
            self.close("width")
        # First equal extreme stays first; no inference from OHLC.
        if self.low is None:
            self.low = self.high = ref
        if self.direction >= 0:
            if price > self.high["priceTicks"]:
                self.high = ref
            if self.high["priceTicks"] - price >= self.reversal:
                self.candidates.append(dict(kind="top", ref=self.high, confirmedUs=ts, segment=self.segment))
                self.direction, self.low = -1, ref
        if self.direction <= 0:
            if price < self.low["priceTicks"]:
                self.low = ref
            if price - self.low["priceTicks"] >= self.reversal:
                self.candidates.append(dict(kind="bottom", ref=self.low, confirmedUs=ts, segment=self.segment))
                self.direction, self.high = 1, ref

    def finish(self):
        self.close("input-end")
        self.finish_candidate()
        return self.bars


def describe_input(symbol):
    config_path = ROOT / "server/research-v2/grid-v22-nq-purchase-only.json"
    config = json.loads(config_path.read_text())
    active_path = ROOT / "data/databento-gc-import/active.json"
    active = json.loads(active_path.read_text())
    sources = {s["symbol"]: s for s in config["sources"]}
    expected_nq = "data/research-v2/nq-purchase-only-01/generation/NQZ26"
    if sources["NQ"]["root"] != expected_nq:
        raise ValueError("NQ source is not the approved purchase-only generation")
    source = sources[symbol]
    root = (ROOT / source["root"]).resolve()
    if symbol == "GC":
        if root != (Path(active["generation"]) / "GCZ26").resolve() or active["sidePolicy"] != "all-outright-v2":
            raise ValueError("GC active manifest and research config disagree")
        if active["rebuilt"]["GCZ26"]["totals"]["unknown"] <= 0:
            raise ValueError("GC purchase generation has no certified N quantity")
    coverage_path, rebuild_path = root / "coverage.json", root / "rebuild.json"
    coverage = json.loads(coverage_path.read_text())["tick"]
    previous = None
    for a, b in coverage:
        integer(a, "coverage.start")
        integer(b, "coverage.end")
        if a >= b or (previous is not None and a < previous):
            raise ValueError("invalid/non-normalized coverage")
        previous = b
    files = []
    for p in sorted((root / "trades" / symbol).glob("*/*.jsonl.gz")):
        hour = datetime.strptime(f"{p.parent.name}/{p.name[:2]}", "%Y-%m-%d/%H").replace(tzinfo=timezone.utc)
        start = int(hour.timestamp() * 1_000_000)
        if start < TO_US and start + 3_600_000_000 > FROM_US:
            files.append(dict(path=str(p.relative_to(root)), sha256=digest(p), startUs=start))
    if not files:
        raise ValueError("no purchased raw trade files")
    manifest = dict(version=VERSION, symbol=symbol, contract=source["contract"], root=str(root.relative_to(ROOT)),
                    requestedFromUs=FROM_US, requestedToUs=TO_US, sessionLabel="CT end date; CT17 boundary",
                    requestedStartDates=["2026-09-29", "2026-10-29"],
                    configSha256=digest(config_path), activeGCSha256=digest(active_path),
                    coverageSha256=digest(coverage_path), rebuildSha256=digest(rebuild_path), files=files)
    return root, manifest, [(a * 1_000_000, b * 1_000_000) for a, b in coverage], active


def generate(symbol, width, reversal_ticks, output_dir=PRIVATE):
    root, manifest, coverage, active = describe_input(symbol)
    input_hash = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    cache_key = hashlib.sha256(f"{input_hash}/{VERSION}/{width}/{reversal_ticks}".encode()).hexdigest()
    output = output_dir / "cache" / f"{symbol}-{width}-{reversal_ticks}-{cache_key}.json"
    if output.exists():
        cached = json.loads(output.read_text())
        copy = dict(cached)
        content_hash = copy.pop("outputHash", None)
        if content_hash != hashlib.sha256(json.dumps(copy, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest():
            raise ValueError("corrupt cached output; preserve file and investigate")
        if cached["inputHash"] != input_hash or cached["cacheKey"] != cache_key:
            raise ValueError("cache identity mismatch")
        return output
    output_dir.mkdir(parents=True, exist_ok=True)
    atomic_json(output_dir / "manifests" / f"{input_hash}.json", manifest)
    builder = Builder(width, reversal_ticks, coverage)
    approved_gc = {s["sha256"] for s in active["staged"]}
    fd, sqlite_path = tempfile.mkstemp(prefix=".sort-", suffix=".sqlite", dir=output_dir)
    os.close(fd)
    try:
        db = sqlite3.connect(sqlite_path)
        db.execute("PRAGMA cache_size=-8192")
        db.execute("PRAGMA temp_store=FILE")
        db.execute("CREATE TABLE raw (ts INTEGER, seq INTEGER, line INTEGER, payload TEXT)")
        for f in manifest["files"]:
            path = root / f["path"]
            db.execute("DELETE FROM raw")
            with gzip.open(path, "rt") as stream:
                for line_no, line in enumerate(stream, 1):
                    t = json.loads(line)
                    ts = integer(t["tsUs"], "tsUs")
                    if not f["startUs"] <= ts < f["startUs"] + 3_600_000_000:
                        raise ValueError("raw row lies outside its UTC-hour adapter partition")
                    if not FROM_US <= ts < TO_US:
                        continue
                    if t.get("contract") != manifest["contract"] or not isinstance(t.get("source"), dict):
                        raise ValueError("contract/provenance missing")
                    if symbol == "GC" and t["source"].get("inputSha256") not in approved_gc:
                        raise ValueError("GC row has unknown purchased provenance")
                    db.execute("INSERT INTO raw VALUES(?,?,?,?)", (ts, integer(t["seq"], "seq"), line_no, line))
            db.commit()
            for ts, seq, line_no, line in db.execute("SELECT * FROM raw ORDER BY ts,seq,line"):
                t = json.loads(line)
                ref = dict(tsUs=ts, seq=seq, priceTicks=t["price"], file=f["path"], line=line_no, source=t["source"])
                builder.add(t, ref)
            # Recheck bytes used, not just an earlier directory snapshot.
            if digest(path) != f["sha256"]:
                raise ValueError("input changed while reading")
        db.close()
    finally:
        os.unlink(sqlite_path)
    bars = builder.finish()
    expected = json.loads((root / "rebuild.json").read_text())["totals"]
    # These pinned generations' certified purchase interval is wholly inside requested session envelope.
    if builder.totals != {k: expected[k] for k in builder.totals}:
        raise ValueError(f"raw/rebuild quantity mismatch: {builder.totals} != certified totals")
    sessions = []
    for i, b in enumerate(bars):
        if not sessions or b["session"] != sessions[-1]["date"]:
            label, start_date, a, z = session(b["startUs"])
            sessions.append(dict(date=label, startDate=start_date, startUs=a, endUs=z, first=i, count=0, partial=False))
        sessions[-1]["count"] += 1
    gaps = missing_intervals(coverage, FROM_US, TO_US)
    import bisect
    starts = [b["startUs"] for b in bars]
    for g in gaps:
        g["at"] = bisect.bisect_left(starts, g["toUs"])
    for s in sessions:
        s["partial"] = any(g["kind"] == "missing" and g["fromUs"] < s["endUs"] and g["toUs"] > s["startUs"] for g in gaps)
    result = dict(version=VERSION, symbol=symbol, contract=manifest["contract"], tickSize=0.25 if symbol == "NQ" else 0.1,
                  width=width, reversalTicks=reversal_ticks, inputHash=input_hash, cacheKey=cache_key,
                  bars=bars, sessions=sessions, gaps=gaps, candidates=builder.candidates, totals=builder.totals,
                  manifest={k: v for k, v in manifest.items() if k != "files"})
    result["outputHash"] = hashlib.sha256(json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    atomic_json(output, result)
    return output


if __name__ == "__main__":
    os.nice(10)
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", choices=["NQ", "GC"], required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--reversal-ticks", type=int, required=True)
    args = parser.parse_args()
    print(generate(args.symbol, args.width, args.reversal_ticks))
