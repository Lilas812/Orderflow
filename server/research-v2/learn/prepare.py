"""Freeze an outcome-blind ledger, THEN read eligible train/validation target values."""
import argparse
from array import array
from bisect import bisect_left
from collections import Counter, defaultdict
import csv
import hashlib
import json
import math
import sys

from common import ct_start, guard, id_hash, rows, sha, write_csv, write_json
from config import ALLOWLIST, CONTENT_HASH, DATASET, PREREGISTRATION, ROOT, TASKS


def read_splits(dataset):
    allowed, sealed = {}, set()
    for r in rows(dataset / "splits.csv"):
        sid = r["sample_id"]
        if r["fold"] == "test":
            sealed.add(sid)
            continue
        assert r["fold"] in ("train", "validation"), "unexpected split"
        assert sid not in allowed and sid not in sealed
        allowed[sid] = r
    assert not (sealed & allowed.keys())
    return allowed, sealed


def non_test_rows(path, allowed, sealed, discarded=None):
    for r in rows(path):
        sid = r["sample_id"]
        if sid in sealed:
            if discarded is not None:
                discarded[path.name] += 1
            continue
        assert sid in allowed, "unexpected non-test ID"
        yield r


def eligible_reasons(sample, split, target_reason, history_good):
    reasons = []
    if split["status"] != "assigned":
        reasons.append("split_unassigned")
    if sample["contract"] != {"NQ": "NQZ26", "GC": "GCZ26"}[sample["symbol"]]:
        reasons.append("contract_unknown")
    if not sample["reference_price_ticks"]:
        reasons.append("reference_missing")
    if target_reason is None:
        reasons.append("target_row_missing")
    elif target_reason:
        reasons.append("target_" + target_reason)
    if not history_good:
        reasons.append("history_1800_incomplete")
    return reasons


class Series:
    def __init__(self):
        self.ts = array("q")
        self.bad = array("I", [0])
        self.close = array("d")
        self.high = array("d")
        self.low = array("d")

    def add(self, r):
        ts = int(r["from_us"])
        assert int(r["to_us"]) == ts + 1_000_000
        assert not self.ts or ts > self.ts[-1], "duplicate/out-of-order shared second"
        self.ts.append(ts)
        self.bad.append(self.bad[-1] + int(r["coverage_mask"] != "1" or r["contract_mask"] != "1"))
        for name in ("close", "high", "low"):
            getattr(self, name).append(float(r[name]) if r[name] else math.nan)

    def window(self, start, end):
        lo, hi = bisect_left(self.ts, start), bisect_left(self.ts, end)
        good = (hi - lo == (end - start) // 1_000_000
                and hi > lo and self.ts[lo] == start and self.ts[hi - 1] == end - 1_000_000
                and self.bad[hi] == self.bad[lo])
        return lo, hi, good


def past_baselines(sample, series):
    asof = int(sample["as_of_us"])
    start = asof - 300_000_000
    parts = []
    previous = None
    for span in json.loads(sample["history_ranges"]):
        s = series[span["series_id"]]
        a, b = max(int(span["from_us"]), start), min(int(span["to_us"]), asof)
        pre = bisect_left(s.ts, start)
        if int(span["from_us"]) < start:
            for i in range(pre - 1, bisect_left(s.ts, int(span["from_us"])) - 1, -1):
                if math.isfinite(s.close[i]):
                    previous = s.close[i]
                    break
        if a < b:
            lo, hi, good = s.window(a, b)
            if not good:
                return None, None
            parts.append((s, lo, hi))
    highs = [s.high[i] for s, lo, hi in parts for i in range(lo, hi) if math.isfinite(s.high[i])]
    lows = [s.low[i] for s, lo, hi in parts for i in range(lo, hi) if math.isfinite(s.low[i])]
    latest = next((s.close[i] for s, lo, hi in reversed(parts)
                   for i in range(hi - 1, lo - 1, -1) if math.isfinite(s.close[i])), previous)
    delta = latest - previous if previous is not None and latest is not None else None
    width = max(highs) - min(lows) if highs and lows else None
    return delta, width


def verify_manifest(dataset):
    manifest = json.loads((dataset / "manifest.json").read_text())
    assert manifest["schema"] == "orderflow.research.v2.2"
    assert manifest["content_hash"] == CONTENT_HASH
    compact = json.dumps(manifest["files"], separators=(",", ":"), ensure_ascii=False).encode()
    assert hashlib.sha256(compact).hexdigest() == CONTENT_HASH
    assert tuple(manifest["x_allowlist"]) == ALLOWLIST
    checks = {}
    for item in manifest["files"]:
        assert "/" not in item["name"] and "\\" not in item["name"]
        checks[item["name"]] = sha(dataset / item["name"])
        assert checks[item["name"]] == item["sha256"], item["name"]
    return manifest, checks


def prepare(dataset, out):
    manifest, checks = verify_manifest(dataset)  # BEFORE reading any market CSV as records
    write_json(out / "preregistration.json", PREREGISTRATION)
    write_json(out / "input-checks.json", {"content_hash": CONTENT_HASH, "files": checks,
               "manifest_sha256": sha(dataset / "manifest.json")})
    splits, sealed = read_splits(dataset)
    write_json(out / "test-seal.json", {"count": len(sealed), "sorted_id_sha256": id_hash(sealed)})
    samples, sessions = {}, {}
    for r in non_test_rows(dataset / "samples.csv", splits, sealed):
        start, date = ct_start(int(r["as_of_us"]))
        r["ct_start"], r["ct_date"] = start, date
        samples[r["sample_id"]] = r
        sessions[(r["symbol"], start)] = date
    assert len(samples) == len(splits)
    assert Counter(symbol for symbol, _ in sessions) == {"NQ": 18, "GC": 18}
    target_reasons = {}
    discarded = Counter()
    for r in non_test_rows(dataset / "targets.csv", splits, sealed, discarded):
        h = int(r["horizon_seconds"])
        if h in (300, 900):
            key = (r["sample_id"], h)
            assert key not in target_reasons
            target_reasons[key] = r["missing_reason"]  # NO Y value lookup/conversion in this pass
    needed_series = {span["series_id"] for s in samples.values() for span in json.loads(s["history_ranges"])}
    series = {k: Series() for k in needed_series}
    for r in rows(dataset / "history-shared.csv"):
        if r["series_id"] not in series:
            continue  # no test-only history retained or interpreted
        series[r["series_id"]].add(r)
    ledger, summary, accepted = [], defaultdict(Counter), set()
    for sid, s in samples.items():
        spans = json.loads(s["history_ranges"])
        duration = sum(int(p["to_us"]) - int(p["from_us"]) for p in spans)
        good = duration == 1_800_000_000 and all(
            series[p["series_id"]].window(int(p["from_us"]), int(p["to_us"]))[2] for p in spans)
        for task, horizon in TASKS.items():
            reasons = eligible_reasons(s, splits[sid], target_reasons.get((sid, horizon)), good)
            counts = summary[(s["symbol"], s["ct_date"], task)]
            counts["total"] += 1
            counts["eligible" if not reasons else "excluded"] += 1
            for reason in reasons:
                counts[reason] += 1
            ledger.append((sid, s["symbol"], s["ct_date"], task, int(not reasons), ";".join(reasons)))
            if not reasons:
                accepted.add((sid, task))
    write_csv(out / "ledger.csv", ("sample_id", "symbol", "ct_date", "task", "eligible", "reasons"), ledger)
    write_json(out / "ledger-summary.json", [
        {"symbol": k[0], "ct_date": k[1], "task": k[2], **dict(v)} for k, v in sorted(summary.items())])
    write_json(out / "ledger-frozen.json", {
        "ledger_sha256": sha(out / "ledger.csv"), "eligible_rows": len(accepted),
        "target_numeric_values_read": False, "test_targets_discarded": discarded["targets.csv"],
        "rule": "all reasons are metadata/masks only; no Y-dependent admission",
    })
    print("LEDGER_FROZEN", sha(out / "ledger.csv"), flush=True)
    del target_reasons, ledger
    xvalues, baselines = {}, {}
    allowed_ids = {sid for sid, _ in accepted}
    for r in non_test_rows(dataset / "features.csv", splits, sealed):
        if r["sample_id"] in allowed_ids:
            assert tuple(k for k in r if k != "sample_id") == ALLOWLIST
            xvalues[r["sample_id"]] = [r[k] for k in ALLOWLIST]
    for sid in allowed_ids:
        baselines[sid] = past_baselines(samples[sid], series)
    del series
    values = {}
    for r in non_test_rows(dataset / "targets.csv", splits, sealed):  # ONLY now interpret eligible numeric Y
        sid = r["sample_id"]
        for task, horizon in TASKS.items():
            if (sid, task) not in accepted or int(r["horizon_seconds"]) != horizon:
                continue
            if task == "range300":
                value = int(r["upward_excursion_ticks"]) + int(r["downward_excursion_ticks"])
                assert value >= 0
            else:
                endpoint = int(r["endpoint_change_ticks"])
                value = int(endpoint > 0) if task == "up900" else endpoint
            values[sid, task] = value
    assert values.keys() == accepted
    header = ["sample_id", "symbol", "ct_date", "ct_start", "task", "as_of_us", "target_end_us",
              "past_delta", "past_range", "y", *ALLOWLIST]
    def ready():
        for sid, task in sorted(accepted):
            assert sid not in sealed
            s = samples[sid]
            delta, width = baselines[sid]
            yield [sid, s["symbol"], s["ct_date"], s["ct_start"], task, s["as_of_us"], s["target_end_us"],
                   "" if delta is None else delta, "" if width is None else width, values[sid, task], *xvalues[sid]]
    write_csv(out / "ready.csv", header, ready())
    write_json(out / "sessions.json", [{"symbol": symbol, "ct_start": start, "ct_date": date}
               for (symbol, start), date in sorted(sessions.items())])
    assert not (allowed_ids & sealed)
    write_json(out / "complete.json", {
        "content_hash": CONTENT_HASH, "ledger_sha256": sha(out / "ledger.csv"),
        "ready_sha256": sha(out / "ready.csv"), "test_output_rows": 0,
        "test_count": len(sealed), "test_id_hash": id_hash(sealed),
    })


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=type(DATASET), default=DATASET)
    parser.add_argument("--out", type=type(ROOT), default=ROOT / "preparation")
    args = parser.parse_args()
    finish = guard(args.out)
    try:
        prepare(args.dataset, args.out)
    except BaseException as exc:
        finish(exc)
        raise
    else:
        finish()
