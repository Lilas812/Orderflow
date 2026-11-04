"""Day-equal metrics, fixed paired day bootstrap, calibration with counts."""
import numpy as np
from sklearn.metrics import roc_auc_score

from config import SEED


def metrics(task, y, predictions):
    if task == "up900":
        p = np.clip(predictions, np.finfo(float).eps, 1 - np.finfo(float).eps)
        loss = -(y * np.log(p) + (1 - y) * np.log1p(-p))
        return {
            "log_loss": float(loss.mean()), "brier": float(np.mean((p - y) ** 2)),
            "auc": float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else None,
        }, loss
    error = predictions - y
    return {"mae": float(np.abs(error).mean()), "median_absolute_error": float(np.median(np.abs(error))),
            "rmse": float(np.sqrt(np.mean(error ** 2)))}, np.abs(error)


def calibration(y, p):
    bins = np.minimum((p * 5).astype(int), 4)
    return [{"bin": b, "low": b / 5, "high": (b + 1) / 5, "n": int((bins == b).sum()),
             "prediction_mean": float(p[bins == b].mean()) if (bins == b).any() else None,
             "observed_rate": float(y[bins == b].mean()) if (bins == b).any() else None}
            for b in range(5)]


def summary(daily):
    result = []
    groups = sorted({(r["symbol"], r["task"], r["model"]) for r in daily})
    for symbol, task, model in groups:
        selected = sorted((r for r in daily if (r["symbol"], r["task"], r["model"]) == (symbol, task, model)),
                          key=lambda r: r["ct_date"])
        base = "prior" if task == "up900" else "median"
        metric = "log_loss" if task == "up900" else "mae"
        baseline = {r["ct_date"]: r[metric] for r in daily if
                    (r["symbol"], r["task"], r["model"]) == (symbol, task, base)}
        assert len(selected) == len(baseline) == 10
        delta = np.array([r[metric] - baseline[r["ct_date"]] for r in selected])
        indices = np.random.default_rng(SEED).integers(0, 10, size=(2000, 10))
        ci = np.quantile(delta[indices].mean(axis=1), [0.025, 0.975])
        values = {k: float(np.mean([r[k] for r in selected if r.get(k) is not None]))
                  for k in ("mae", "median_absolute_error", "rmse", "log_loss", "brier", "auc")
                  if any(r.get(k) is not None for r in selected)}
        result.append({"symbol": symbol, "task": task, "model": model,
            "primary": task == "endpoint300" and model == "gbdt",
            "days": 10, "evaluation_rows": sum(r["n"] for r in selected), "baseline": base,
            "metric": metric, "day_equal_loss": values[metric], "delta": float(delta.mean()),
            "ci95_low": float(ci[0]), "ci95_high": float(ci[1]),
            "auc_defined_days": sum(r.get("auc") is not None for r in selected) if task == "up900" else None,
            **values})
    return result
