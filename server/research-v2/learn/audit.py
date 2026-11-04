"""Bounded streaming hashes of immutable inputs and independent output sealing/repro checks."""
import argparse
import json
from pathlib import Path

from common import guard, id_hash, rows, sha, write_json
from config import DATASET, ROOT
from prepare import read_splits, verify_manifest


def protected():
    prior = Path("data/research-v2/ct1026-comparison-01/protected-after.json")
    entries = json.loads(prior.read_text())
    result = {}
    for item in entries:
        value = sha(item["path"])
        assert value == item["sha256"], item["path"]
        result[item["path"]] = value
    for root in (DATASET, Path("data/research-v2/ct1026-full-02/dataset")):
        for p in sorted(root.rglob("*")):
            if p.is_file():
                result[str(p)] = sha(p)
    return result


def audit(stage, out):
    if stage == "before":
        write_json(out / "protected.json", protected())
        return
    before = json.loads((ROOT / "audit-before/protected.json").read_text())
    after = protected()
    assert before == after
    verify_manifest(DATASET)
    allowed, sealed = read_splits(DATASET)
    prep = ROOT / "preparation"
    for file in ("ledger.csv", "ready.csv"):
        for r in rows(prep / file):
            assert r["sample_id"] not in sealed and r["sample_id"] in allowed
    manifests = [json.loads((ROOT / folder / "run-manifest.json").read_text()) for folder in ("run-01", "run-02")]
    for key in ("source_files", "lock_sha256", "installed_versions", "preregistration", "ledger_sha256",
                "ready_sha256", "predictions_sha256", "test_id_hash", "evaluation_id_hash"):
        assert manifests[0][key] == manifests[1][key], key
    counts = []
    for folder, manifest in zip(("run-01", "run-02"), manifests):
        seen, count = set(), 0
        for r in rows(ROOT / folder / "predictions.csv"):
            assert r["sample_id"] in allowed and r["sample_id"] not in sealed
            count += 1
            seen.add(r["sample_id"])
        assert id_hash(seen) == manifest["evaluation_id_hash"]
        assert sha(ROOT / folder / "predictions.csv") == manifest["predictions_sha256"]
        resource = json.loads((ROOT / folder / "resources.json").read_text())
        assert resource["success"] and resource["elapsed_seconds"] <= 1800
        assert resource["peak_rss_kib"] * 1024 < 3 * 1024**3
        assert resource["nice"] == 19
        counts.append(count)
    write_json(out / "verification.json", {
        "protected_files": len(after), "protected_unchanged": True, "input_manifest_pass": True,
        "same_source_and_lock": True, "predictions_hash": manifests[0]["predictions_sha256"],
        "two_runs_equal": True, "prediction_rows": counts, "test_ids": len(sealed),
        "test_id_hash": id_hash(sealed), "test_ids_in_any_ledger_ready_predictions": 0,
    })


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("before", "after"))
    args = parser.parse_args()
    out = ROOT / ("audit-" + args.stage)
    finish = guard(out)
    try:
        audit(args.stage, out)
    except BaseException as exc:
        finish(exc)
        raise
    else:
        finish()
