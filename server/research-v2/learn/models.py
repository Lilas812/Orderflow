"""Train-only transforms and fixed small models. No test reader."""
import numpy as np
from sklearn.linear_model import LogisticRegression, QuantileRegressor
from lightgbm import LGBMClassifier, LGBMRegressor

from config import ALLOWLIST, PREREGISTRATION, QUANTILE_ALPHA, SEED


def number(value):
    return float(value) if value not in ("", None) else np.nan


class TrainTransform:
    """No fit on evaluation data; vocabulary and every statistic come from fit(rows)."""
    def fit(self, rows):
        self.fit_ids = frozenset(r["sample_id"] for r in rows)
        self.numeric = ALLOWLIST[1:]
        a = np.array([[number(r[k]) for k in self.numeric] for r in rows], dtype=np.float64)
        self.keep = np.isfinite(a).any(axis=0)
        self.dropped = [k for k, keep in zip(self.numeric, self.keep) if not keep]
        a = a[:, self.keep]
        self.medians = np.nanmedian(a, axis=0)
        filled = np.where(np.isnan(a), self.medians, a)
        self.means, self.scales = filled.mean(axis=0), filled.std(axis=0)
        self.scales[self.scales == 0] = 1
        self.vocabulary = sorted({r["session"] for r in rows if r["session"]})
        assert np.isfinite(self.medians).all()
        return self

    def transform(self, rows, linear):
        a = np.array([[number(r[k]) for k in self.numeric] for r in rows], dtype=np.float64)[:, self.keep]
        flags = np.isnan(a).astype(float)
        category = np.zeros((len(rows), len(self.vocabulary) + 1))
        lookup = {k: i for i, k in enumerate(self.vocabulary)}
        for i, r in enumerate(rows):
            category[i, lookup.get(r["session"], len(self.vocabulary))] = 1
        if linear:
            a = (np.where(np.isnan(a), self.medians, a) - self.means) / self.scales
        result = np.concatenate([a, flags, category], axis=1)
        assert result.shape[1] == 2 * int(self.keep.sum()) + len(self.vocabulary) + 1
        return result


def train_models(task):
    gb = dict(PREREGISTRATION["gbdt"])
    gb.pop("regression_objective")
    gb.pop("classification_objective")
    gb.update(random_state=SEED, verbosity=-1, bagging_seed=SEED,
              feature_fraction_seed=SEED, data_random_seed=SEED, drop_seed=SEED)
    if task == "up900":
        return [
            ("logistic", LogisticRegression(C=1, max_iter=1000, random_state=SEED)),
            ("gbdt", LGBMClassifier(objective="binary", **gb)),
        ]
    return [
        ("quantile", QuantileRegressor(quantile=0.5, alpha=QUANTILE_ALPHA, solver="highs",
          solver_options={"threads": 2, "parallel": False, "random_seed": SEED})),
        ("gbdt", LGBMRegressor(objective="regression_l1", **gb)),
    ]


def baselines(task, train, evaluation):
    y = np.array([float(r["y"]) for r in train])
    if task == "up900":
        prior = float((y.sum() + 1) / (len(y) + 2))
        conditioned, supported = {}, {}
        for sign in (-1, 0, 1):
            selected = [float(r["y"]) for r in train
                        if r["past_delta"] != "" and np.sign(float(r["past_delta"])) == sign]
            supported[sign] = bool(selected)
            conditioned[sign] = (sum(selected) + 1) / (len(selected) + 2) if selected else prior
        fallbacks = sum(r["past_delta"] == "" or not supported[int(np.sign(float(r["past_delta"])))]
                        for r in evaluation)
        p = [prior if r["past_delta"] == "" else conditioned[int(np.sign(float(r["past_delta"])))]
             for r in evaluation]
        return [("prior", np.full(len(evaluation), prior)), ("momentum", np.array(p))], fallbacks
    median = float(np.median(y))
    key = "past_range" if task == "range300" else "past_delta"
    fallbacks = sum(r[key] == "" for r in evaluation)
    results = [("median", np.full(len(evaluation), median)), ("momentum",
               np.array([median if r[key] == "" else float(r[key]) for r in evaluation]))]
    if task == "endpoint300":
        results.insert(0, ("zero", np.zeros(len(evaluation))))
    return results, fallbacks
