"""One bounded run of all fixed walk-forward comparisons. Output directory must be new."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import warnings

from common import guard, id_hash, purge, rows, sha, write_csv, write_json
from config import ALLOWLIST, DATASET, PREREGISTRATION, ROOT, TASKS
from prepare import read_splits, verify_manifest


def run(preparation, out):
    # Imports happen after guard(), and only the private site directory is added by the shell.
    import numpy as np
    from threadpoolctl import threadpool_info, threadpool_limits
    from models import TrainTransform, baselines, train_models
    from evaluate import calibration, metrics, summary
    assert sys.version_info[:2] in ((3, 11), (3, 12))
    expected = dict(line.strip().split("==") for line in
        (Path(__file__).parent / "requirements.lock").read_text().splitlines() if line and not line.startswith("#"))
    installed = {name: importlib.metadata.version(name) for name in expected}
    assert installed == expected, (installed, expected)
    private_site = (ROOT / "python-site").resolve()
    for name in installed:
        location = importlib.metadata.distribution(name).locate_file("").resolve()
        assert location == private_site, (name, str(location), "non-private dependency")
    # No market data read before payload hash verification, in each independent run.
    manifest, checks = verify_manifest(DATASET)
    complete = json.loads((preparation / "complete.json").read_text())
    assert sha(preparation / "ready.csv") == complete["ready_sha256"]
    assert sha(preparation / "ledger.csv") == complete["ledger_sha256"]
    assert json.loads((preparation / "preregistration.json").read_text()) == PREREGISTRATION
    _, sealed = read_splits(DATASET)
    assert id_hash(sealed) == complete["test_id_hash"]
    data = []
    for r in rows(preparation / "ready.csv"):
        assert r["sample_id"] not in sealed, "test leakage"
        assert r["task"] in TASKS
        assert set(ALLOWLIST) <= r.keys()
        data.append(r)
    schedule = json.loads((preparation / "sessions.json").read_text())
    daily, audits, calibration_rows, all_output_ids = [], [], [], set()
    header = ["sample_id", "symbol", "task", "ct_date", "model", "y", "prediction", "loss"]
    warning_log = []
    with open(out / "predictions.csv", "x", newline="") as f:
        import csv
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(header)
        with threadpool_limits(limits=2):
            for symbol in ("NQ", "GC"):
                sessions = sorted((s for s in schedule if s["symbol"] == symbol), key=lambda s: s["ct_start"])
                assert len(sessions) == 18
                for task in TASKS:
                    subset = [r for r in data if r["symbol"] == symbol and r["task"] == task]
                    for fold in range(8, 18):
                        evaluation_session = sessions[fold]
                        allowed_sessions = {s["ct_start"] for s in sessions[:fold]}
                        training = [r for r in subset if int(r["ct_start"]) in allowed_sessions]
                        training, purged = purge(training, evaluation_session["ct_start"])
                        evaluation = sorted((r for r in subset if int(r["ct_start"]) == evaluation_session["ct_start"]),
                                            key=lambda r: (int(r["as_of_us"]), r["sample_id"]))
                        assert training and evaluation, "empty fold; do not silently skip evaluation day"
                        train_ids = {r["sample_id"] for r in training}
                        eval_ids = {r["sample_id"] for r in evaluation}
                        assert not (train_ids & eval_ids) and not ((train_ids | eval_ids) & sealed)
                        assert max(int(r["ct_start"]) for r in training) < evaluation_session["ct_start"]
                        transformer = TrainTransform().fit(training)
                        assert transformer.fit_ids == train_ids
                        train_y = np.array([float(r["y"]) for r in training])
                        eval_y = np.array([float(r["y"]) for r in evaluation])
                        forecasts, fallback_count = baselines(task, training, evaluation)
                        audit = {"symbol": symbol, "task": task, "ct_date": evaluation_session["ct_date"],
                            "train_sessions": fold, "train_n": len(training), "evaluation_n": len(evaluation),
                            "purged_target_end": purged, "momentum_fallbacks": fallback_count,
                            "fit_id_hash": id_hash(train_ids), "eval_id_hash": id_hash(eval_ids),
                            "fit_eval_intersection": 0, "dropped_all_null_columns": transformer.dropped,
                            "session_vocabulary": transformer.vocabulary, "single_training_class": False}
                        for model_name, model in train_models(task):
                            linear = model_name != "gbdt"
                            x_train = transformer.transform(training, linear)
                            x_eval = transformer.transform(evaluation, linear)
                            assert x_train.shape[1] == x_eval.shape[1]
                            with warnings.catch_warnings(record=True) as caught:
                                warnings.simplefilter("always")
                                if task == "up900" and len(np.unique(train_y)) < 2:
                                    audit["single_training_class"] = True
                                    prediction = forecasts[0][1].copy()
                                else:
                                    model.fit(x_train, train_y)
                                    prediction = model.predict_proba(x_eval)[:, 1] if task == "up900" else model.predict(x_eval)
                                warning_log.extend({"symbol": symbol, "task": task, "date": evaluation_session["ct_date"],
                                                    "model": model_name, "message": str(w.message)} for w in caught)
                            assert np.isfinite(prediction).all()
                            forecasts.append((model_name, prediction))
                            del x_train, x_eval, model
                        for model_name, prediction in forecasts:
                            values, losses = metrics(task, eval_y, prediction)
                            daily.append({"symbol": symbol, "task": task, "ct_date": evaluation_session["ct_date"],
                                          "model": model_name, "n": len(evaluation), **values})
                            for r, y, p, loss in zip(evaluation, eval_y, prediction, losses):
                                assert r["sample_id"] not in sealed
                                writer.writerow([r["sample_id"], symbol, task, evaluation_session["ct_date"], model_name,
                                                 format(y, ".17g"), format(p, ".17g"), format(loss, ".17g")])
                                all_output_ids.add(r["sample_id"])
                            if task == "up900":
                                for b in calibration(eval_y, prediction):
                                    calibration_rows.append({"symbol": symbol, "task": task, "ct_date": evaluation_session["ct_date"],
                                                             "model": model_name, **b})
                        audits.append(audit)
                        print(f"FOLD_DONE {symbol} {task} {evaluation_session['ct_date']} n={len(evaluation)}", flush=True)
    assert len(audits) == 60 and not (all_output_ids & sealed)
    write_json(out / "daily.json", daily)
    daily_columns = ["symbol", "task", "ct_date", "model", "n", "mae", "median_absolute_error", "rmse", "log_loss", "brier", "auc"]
    write_csv(out / "daily.csv", daily_columns, ([r.get(k) for k in daily_columns] for r in daily))
    write_json(out / "summary.json", summary(daily))
    write_json(out / "calibration-daily.json", calibration_rows)
    write_json(out / "fold-audit.json", audits)
    write_json(out / "warnings.json", warning_log)
    source_files = sorted(Path(__file__).parent.glob("*.py"))
    write_json(out / "run-manifest.json", {
        "input_content_hash": manifest["content_hash"], "input_files": checks,
        "source_files": {str(p): sha(p) for p in source_files}, "lock_sha256": sha(Path(__file__).parent / "requirements.lock"),
        "installed_versions": installed, "preregistration": PREREGISTRATION,
        "ledger_sha256": complete["ledger_sha256"], "ready_sha256": complete["ready_sha256"],
        "predictions_sha256": sha(out / "predictions.csv"),
        "test_count": len(sealed), "test_id_hash": id_hash(sealed), "test_output_rows": 0,
        "evaluation_id_hash": id_hash(all_output_ids), "folds": len(audits),
        "thread_pools": threadpool_info(),
        "thread_environment": {k: os.environ.get(k) for k in
            ("OMP_NUM_THREADS", "OMP_THREAD_LIMIT", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "HIGHS_THREADS")},
        "native_runtime": {name: sha(Path(os.environ["ORDERFLOW_LEARN_NATIVE_LIB"]) / name)
                           for name in ("libstdc++.so.6", "libgomp.so.1")},
    })


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--preparation", type=Path, default=ROOT / "preparation")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    finish = guard(args.out)
    try:
        run(args.preparation, args.out)
    except BaseException as exc:
        finish(exc)
        raise
    else:
        finish()
