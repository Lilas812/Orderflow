"""Preregistered choices. No tuning or test evaluation."""
from pathlib import Path

DATASET = Path("data/research-v2/ct1026-full-01/dataset")
ROOT = Path("data/research-v2/learn-01")
CONTENT_HASH = "0474911e318c54115ddd8f93042c278c424f6e3144a1d9c450b1e832e34380dc"
SEED = 20261105
THREADS = 2
MEMORY_BYTES = 3 * 1024**3
WALL_SECONDS = 1800
QUANTILE_ALPHA = 0.01  # fixed before Y: standardized X; do not copy Ridge's differently-scaled penalty
TASKS = {"endpoint300": 300, "up900": 900, "range300": 300}
ALLOWLIST = (
    "session", "minutes_from_ct17", "minutes_from_us_open", "rv_5m", "rv_30m",
    "range_30m", "direction_30m", "distance_session_high", "distance_session_low",
    "distance_poc", "distance_vah", "distance_val", "distance_round",
    "cvd_slope_10m", "cvd_divergence", "absorption_buy_60s", "absorption_sell_60s",
    "imbalance_1", "imbalance_5", "imbalance_10", "near_size", "near_change_60s",
    "buy_30s", "sell_30s", "unknown_30s", "total_30s", "delta_30s",
    "buy_60s", "sell_60s", "unknown_60s", "total_60s", "delta_60s",
    "buy_5m", "sell_5m", "unknown_5m", "total_5m", "delta_5m",
)
PREREGISTRATION = {
    "content_hash": CONTENT_HASH, "seed": SEED, "tasks": TASKS,
    "input": "A only; shared history used only for eligibility and causal baselines",
    "test": "discard immediately after ID lookup; never evaluate",
    "folds": "first 8 sessions fit; next session evaluate; expanding 10 times",
    "target_end": "existing samples.target_end_us (maximum 900s), <= evaluation session start",
    "linear": {"quantile": 0.5, "alpha": QUANTILE_ALPHA, "solver": "highs",
               "logistic_C": 1, "logistic_max_iter": 1000},
    "gbdt": {"num_leaves": 7, "max_depth": 3, "min_child_samples": 100,
             "learning_rate": 0.05, "n_estimators": 200, "num_threads": 2,
             "deterministic": True, "force_col_wise": True, "seed": SEED,
             "regression_objective": "regression_l1", "classification_objective": "binary"},
    "preprocessing": "train-only all-null removal, medians, missing flags, numeric standardization (linear only), session one-hot vocabulary",
    "momentum": "reference before as_of minus last real close before as_of-300s; range from real highs/lows in [as_of-300s,as_of); missing -> training median/probability",
    "momentum_classification": "train-only Laplace +1 probability conditional on sign of past300 endpoint; missing -> unconditional",
    "primary": "endpoint300 GBDT MAE minus training-median MAE, separately NQ/GC",
    "bootstrap": {"unit": "paired evaluation session", "draws": 2000, "seed": SEED, "CI": 0.95},
    "no_hyperparameter_search": True, "memory_bytes": MEMORY_BYTES,
    "wall_seconds": WALL_SECONDS, "threads": THREADS, "nice": 19,
}
